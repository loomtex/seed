# Seed

NixOS instances running in hardware-isolated microVMs. Write a NixOS module, push, and it boots on [seed.loom.farm](https://loom.farm) with automatic TLS, DNS, persistent storage, and encrypted secrets.

Each instance is a full NixOS system — `services.nginx`, `services.postgresql`, `services.openssh`, whatever you'd put in a NixOS config. Seed adds a thin `seed.*` module for platform glue.

If you're an AI agent deploying to Seed (or a human pointing one at it), skip to the [technical reference](#technical-reference).

## How it works

You write a nix flake that exports `seeds.<name>` for each instance. The platform evaluates your flake, builds the NixOS closure, and boots it in a [Kata Containers](https://katacontainers.io/) microVM. Every instance gets:

- **DNS**: `<instance>.<namespace>.seed.loom.farm` — resolves immediately
- **TLS**: Automatic Let's Encrypt certificates via the platform's embedded ACME server
- **Identity**: TPM-backed SPIFFE certificates for mTLS between instances — each VM has a hardware-bound private key that never leaves the TPM
- **Storage**: Persistent volumes that survive restarts and redeployments
- **Secrets**: A virtual TPM device for encrypted secrets via [sops-nix](https://github.com/Mic92/sops-nix)
- **Git hosting**: Push to [Silo](https://silo.loom.farm) — no GitHub account needed
- **Logs & management**: `ssh seed.loom.farm logs <instance>`, `status`, `restart`

There's no Docker, no image registry, no Helm, no YAML. NixOS is the abstraction.

## Why NixOS

Because, Nix is perfectly positioned to never be typed by a human again. Seed leans into that.
 
Seed uses NixOS as the instance abstraction instead of containers. Every instance is a real NixOS system evaluated from a nix flake.

The full NixOS module ecosystem is available — `services.postgresql`, `security.acme`, `services.openssh`, `sops-nix` — with correct service dependencies, user management, and systemd lifecycle. Multi-service instances are just NixOS config.

The tradeoff is boot time (systemd startup, not millisecond cold starts). Seed isn't a function runtime, but you can absolutely run one on it.

Because NixOS is declarative, typed, reproducible, and introspectable, it is trivially wielded by modern LLMs. An agent can compose NixOS modules, debug systemd journals, and reason about option types without the friction a human faces.

## Getting started

### 1. Write a flake

```bash
nix flake init -t git+ssh://silo.loom.farm/seed.git#instance          # nginx static site
nix flake init -t git+ssh://silo.loom.farm/seed.git#instance-caddy    # Caddy reverse proxy with TLS
nix flake init -t git+ssh://silo.loom.farm/seed.git#instance-api      # API server with sops secrets
nix flake init -t git+ssh://silo.loom.farm/seed.git#multi             # web frontend + API backend
```

The basic `instance` template creates two files:

```nix
# flake.nix
{
  inputs.seed.url = "git+ssh://silo.loom.farm/seed.git";
  inputs.nixpkgs.follows = "seed/nixpkgs";

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkSeed {
      name = "web";
      module = ./web.nix;
    };
  };
}
```

```nix
# web.nix
{ pkgs, ... }:

{
  seed.size = "xs";
  seed.expose.http.enable = true;
  seed.storage.data = "1Gi";

  services.nginx.enable = true;
  services.nginx.virtualHosts.default = {
    listen = [{ addr = "0.0.0.0"; port = 80; }];
    root = "/seed/storage/data/www";
  };
}
```

### 2. Add `.authorized_keys`

Create an `.authorized_keys` file in the repo root containing the SSH public keys that should have access. Standard `authorized_keys` format:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... you@machine
```

This is how the platform identifies you. Your SSH key proves ownership of the repo — there are no passwords or API tokens.

### 3. Plant

Each flake has a stable identity — an IPNS CID derived from an Ed25519 keypair. Your namespace is computed deterministically from this CID, and the private key proves ownership during `plant`.

Push your flake to a git remote, then use `seed-plant` to generate an identity and register in one step:

```bash
# Push to Silo (built-in git hosting, no account needed)
git remote add origin silo.loom.farm:my-app.git
git push -u origin master

# Plant — generates .seed-identity-key + .seed-identity, signs, and registers
nix run git+ssh://silo.loom.farm/seed.git#seed-plant -- silo:my-app <invite-code>
```

This generates an Ed25519 keypair at `.seed-identity-key`, derives the IPNS CID to `.seed-identity`, signs the invite code, and calls `ssh seed.loom.farm plant`. Commit `.seed-identity` to your repo (it's the public CID). Add `.seed-identity-key` to `.gitignore`.

If you already have an identity key, pass it as a third argument:

```bash
nix run git+ssh://silo.loom.farm/seed.git#seed-plant -- silo:my-app <invite-code> ~/.ssh/my-seed-key
```

The individual tools are also available separately:

```bash
# Derive IPNS CID from an SSH key (accepts public or private key)
nix run git+ssh://silo.loom.farm/seed.git#seed-identity -- .seed-identity-key.pub

# Sign an invite code
nix run git+ssh://silo.loom.farm/seed.git#seed-sign -- <invite-code> .seed-identity-key
```

Hardware keys (e.g. Yubikey) work too — generate an `ed25519-sk` key, then use the individual tools:

```bash
ssh-keygen -t ed25519-sk -f .seed-identity-key
nix run git+ssh://silo.loom.farm/seed.git#seed-identity -- .seed-identity-key.pub > .seed-identity
SIG=$(nix run git+ssh://silo.loom.farm/seed.git#seed-sign -- <invite-code> .seed-identity-key)
ssh seed.loom.farm plant silo:my-app <invite-code> "$SIG"
```

Check status after planting:

```bash
ssh seed.loom.farm status
ssh seed.loom.farm logs web
```

After the initial `plant`, every `git push` triggers automatic redeployment via webhook.

### 4. Verify locally

Before pushing, validate your instance config:

```bash
nix eval .#seeds.web.meta --json
```

This type-checks the full NixOS evaluation and returns controller metadata without building anything. Option mismatches, missing values, and module conflicts surface here — not at deploy time.

## Instance options

### `seed.size`

VM sizing tier. Defaults to `"xs"`.

| Tier | vCPUs | Memory |
|------|-------|--------|
| `xs` | 1 | 512 MB |
| `s` | 1 | 1 GB |
| `m` | 2 | 2 GB |
| `l` | 4 | 4 GB |
| `xl` | 8 | 8 GB |

### `seed.expose`

Ports to expose. Entry names are looked up in a well-known service table (derived from `/etc/services`) for default port and protocol, so common services need no configuration:

```nix
seed.expose.https.enable = true;       # 443/tcp, ACME-enabled
seed.expose.ssh.enable = true;         # 22/tcp
seed.expose.dns.enable = true;         # 53, TCP+UDP
seed.expose.postgresql.enable = true;  # 5432/tcp
```

Override defaults or define custom services:

```nix
seed.expose.https.port = 8443;                          # override default port
seed.expose.myapp = { port = 9090; protocol = "tcp"; }; # not well-known, specify both
seed.expose.http = 8080;                                 # bare port shorthand
```

Protocols: `tcp`, `udp`, `dns` (both TCP+UDP), `http` (ACME-enabled), `grpc` (ACME-enabled).

When the protocol is `http` or `grpc`, the platform injects `SEED_ACME_URL` — an ACME directory endpoint that proxies to Let's Encrypt. Your instance's web server (e.g. Caddy) uses its built-in ACME client to request certificates through this endpoint.

### `seed.storage`

Persistent volumes. Accepts a size string (mounted at `/seed/storage/<name>`) or an attrset with `size`, `mountPoint`, `user`, `group`, and `mode`.

```nix
seed.storage.data = "1Gi";                                       # /seed/storage/data
seed.storage.cache = { size = "500Mi"; mountPoint = "/tmp/cache"; }; # custom mount
seed.storage.db = { size = "10Gi"; user = "postgres"; group = "postgres"; }; # owned by postgres
```

PVC filesystems are root-owned by default. Set `user` and `group` to chown the mount point for services that run as a non-root user — this replaces manual `systemd.tmpfiles.rules`.

Storage survives pod restarts and redeployments. PVCs are never garbage-collected.

### `seed.dns.names`

Custom DNS names for this instance. Each entry gets an AAAA record pointing at the instance's IPv6 ingress address. Names must belong to a domain declared in `combine.domains` in your flake (see [Custom domains](#custom-domains)).

```nix
seed.dns.names = [ "example.com" "www.example.com" ];
```

### `seed.rollout`

Deployment strategy. `"recreate"` (default) stops the old instance before starting the new one — safe for stateful services. `"rolling"` starts the new instance first for zero-downtime updates.

## TLS

When any `seed.expose` entry uses the `http` or `grpc` protocol, `seed.acme` is automatically enabled. This configures NixOS's `security.acme` to use the platform's embedded ACME server (which proxies DNS-01 validation to Let's Encrypt) — no manual ACME configuration needed.

You can also set `seed.acme = true` explicitly for protocols that don't auto-enable it.

For **nginx**, just use `enableACME` and `forceSSL` — the ACME server and email are pre-configured:

```nix
{
  seed.expose.http.enable = true;
  seed.expose.https.enable = true;
  seed.storage.acme = { size = "100Mi"; mountPoint = "/var/lib/acme"; };

  services.nginx = {
    enable = true;
    virtualHosts."my-app.example.com" = {
      enableACME = true;
      forceSSL = true;
      root = "/seed/storage/data/www";
    };
  };
}
```

For **Caddy**, point its ACME client at `SEED_ACME_URL` (Caddy has its own ACME implementation, independent of `security.acme`):

```nix
{ pkgs, ... }:

{
  seed.expose.https.enable = true;
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN} {
        root * /seed/storage/data/www
        file_server
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";
}
```

Certificates are real Let's Encrypt certs, browser-trusted. Persist `/var/lib/acme` (nginx) or `/var/lib/caddy` (Caddy) via `seed.storage` to avoid hitting rate limits on redeployment.

## DNS

Every instance automatically gets a DNS name at `<instance>.<namespace>.seed.loom.farm`. The namespace is derived deterministically from your flake identity (see [Create an identity](#3-create-an-identity)) — you don't choose it, but it's stable. AAAA records are created and updated automatically as instances deploy and get their IPv6 ingress addresses from MetalLB.

No configuration needed — if your instance has any `seed.expose` entries, it gets a DNS name.

### Custom domains

Register your own domain by declaring it in `combine.domains` in your flake:

```nix
{
  outputs = { seed, ... }: {
    combine.domains = {
      "example.com" = {
        register = true;   # platform registers via NameSilo and sets NS records
        default = true;    # used as default domain for unqualified DNS names
      };
    };

    seeds.web = seed.lib.mkSeed {
      name = "web";
      module = ./web.nix;
    };
  };
}
```

Then point instance DNS names at your domain with `seed.dns.names`:

```nix
# web.nix
{
  seed.expose.https.enable = true;
  seed.dns.names = [ "example.com" "www.example.com" ];
  # ...
}
```

The platform handles the full lifecycle:

1. **Registration**: If `register = true`, the controller registers the domain via NameSilo, sets nameservers to `ns1.loom.farm` / `ns2.loom.farm`, and creates the zone in PowerDNS
2. **Zone setup**: SOA and NS records are created automatically
3. **Instance records**: AAAA records are created for each `seed.dns.names` entry, pointing at the instance's IPv6 ingress address
4. **Wildcards**: Zone apex names (e.g. `example.com`) automatically get a wildcard record (`*.example.com`) too

If you already own the domain and manage it at another registrar, set `register = false` and point your NS records at `ns1.loom.farm` / `ns2.loom.farm` manually. Once delegation propagates, the controller creates the zone and manages records.

DNS records sync within seconds of deployment. Records track the instance's LoadBalancer IP — if the address changes, records update automatically.

## Environment variables

The platform injects environment variables into every instance pod. Inside the Kata VM, these are captured at activation time to `/run/seed/env`. Use `EnvironmentFile` in systemd services to access them:

```nix
systemd.services.myapp.serviceConfig.EnvironmentFile = "/run/seed/env";
```

| Variable | Injected when | Value |
|----------|---------------|-------|
| `SEED_FQDN` | `seed.acme = true` | `<instance>.<namespace>.seed.loom.farm` — the instance's auto-generated hostname |
| `SEED_ACME_URL` | `seed.acme = true` | Platform ACME directory endpoint (RFC 8555) for TLS certificates |
| `SEED_NAMESPACE` | always | k8s namespace (e.g. `s-gaydazldmnsg`) |
| `SEED_INSTANCE` | always | Instance name (e.g. `web`) |
| `SEED_NODE_IP` | always | Host node's IP address |
| `SEED_SHOOT_URL` | `seed.shoot.enable = true` | Pool manager endpoint for ephemeral VM forking |
| `SEED_EST_URL` | always (if platform CA available) | Certificate enrollment endpoint |

`SEED_ACME_URL` and `SEED_FQDN` are auto-enabled when any `seed.expose` entry uses the `http` or `grpc` protocol. Most instances only need these two — point your web server's ACME client at `SEED_ACME_URL` and serve on `SEED_FQDN`.

## Secrets

Instances get a virtual TPM device backed by [swtpm](https://github.com/stefanberger/swtpm). On first boot, a TPM-backed [age](https://github.com/FiloSottile/age) identity is generated at `/seed/tpm/age-identity`. Use this with [sops-nix](https://github.com/Mic92/sops-nix) for encrypted secrets:

```nix
{ config, ... }:

{
  sops.defaultSopsFile = ./secrets/myapp.yaml;
  sops.secrets.api-key = {};

  services.myapp.environmentFile = config.sops.secrets.api-key.path;
}
```

`sops.age.keyFile` defaults to `/seed/tpm/age-identity` — no extra configuration needed.

### Provisioning flow

1. Deploy the instance without secrets. It boots and generates a TPM identity.
2. Read the public key: `ssh seed.loom.farm keys web` — outputs the `age1tpm1q...` recipient.
3. Encrypt your secrets: `sops --age 'age1tpm1q...' secrets/myapp.yaml`
4. Redeploy. sops-nix decrypts via the vTPM automatically.

## Multiple instances

A flake can export any number of instances. They share a namespace.

```nix
{
  inputs.seed.url = "git+ssh://silo.loom.farm/seed.git";
  inputs.nixpkgs.follows = "seed/nixpkgs";

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkSeed { name = "web"; module = ./web.nix; };
    seeds.api = seed.lib.mkSeed { name = "api"; module = ./api.nix; };
    seeds.db  = seed.lib.mkSeed { name = "db";  module = ./db.nix; };
  };
}
```

## Silo

Seed includes built-in git hosting at `silo.loom.farm`. No account needed — your SSH key is your identity.

```bash
git clone silo.loom.farm:my-app.git    # clone (anyone)
git push silo.loom.farm:my-app.git     # push (requires key in .authorized_keys)
```

Repos are created automatically on first push. The key that creates the repo becomes the owner. Collaborators are managed via the `.authorized_keys` file in the repo root — push a new key there to grant access.

Read access is public. Write access requires a key listed in `.authorized_keys`.

When registering with `plant`, use the `silo:` shorthand:

```bash
ssh seed.loom.farm plant silo:my-app <invite-code>
```

Silo also has a web interface at `https://silo.loom.farm` for browsing repos, with syntax highlighting and tarball downloads.

## Seed shell

All management happens over SSH at `seed.loom.farm`. Connect with no command to get an interactive TUI dashboard:

```bash
ssh seed.loom.farm                     # interactive TUI (requires TTY)
```

Or pass commands directly:

```bash
ssh seed.loom.farm status              # instance status across all your repos
ssh seed.loom.farm status my-repo      # status for a specific repo
ssh seed.loom.farm status -w 5         # watch mode — refresh every 5s
ssh seed.loom.farm logs web            # last 100 log lines
ssh seed.loom.farm logs web -f         # stream logs
ssh seed.loom.farm logs web --lines 500
ssh seed.loom.farm logs my-repo/web    # disambiguate repo/instance
ssh seed.loom.farm restart web         # restart an instance
ssh seed.loom.farm help                # show all commands
```

All commands support `--json` for machine-readable output.

Any SSH key can connect. Your key identity determines which repos you can manage — if your key is in a repo's `.authorized_keys`, you see that repo.

## Shoots

Shoots are ephemeral VMs that share the parent instance's nix closure and persistent storage — like `fork()` for seed instances. Enable them with:

```nix
seed.shoot.enable = true;
```

This gives the instance a `seed-shoot` command and a `SEED_SHOOT_URL` env var pointing to the node-local pool manager.

### Usage

```bash
seed-shoot echo "hello from shoot"              # run in isolated VM
seed-shoot sha256sum /seed/storage/data/in.bin  # access parent's storage
seed-shoot --timeout 60000 long-running-task    # timeout in ms
```

Each shoot runs in its own hardware-isolated microVM. No network interface — communication is via shared storage and stdout/stderr only.

### Use cases

- **Parallel computation**: Fan out work across shoots, each gets its own CPU/memory
- **Sandboxed execution**: Run untrusted code — if it crashes, only the ephemeral VM is affected
- **Batch processing**: Queue work to shared storage, fork shoots to process items

### Limitations

- No network inside shoots
- No vTPM — pass secrets via shared storage if needed
- Nix store is read-only (can run binaries, can't build)
- Same physical node as parent

## Instance modules

Seed includes reusable modules for common platform services. These handle the complexity of connecting to shared infrastructure — mTLS proxy setup, TPM-bound certificates, database initialization — so instance authors don't have to.

### PostgreSQL (`seed.services.postgresql`)

Shared PostgreSQL with SPIFFE mTLS client certificate authentication. Clients present their instance's TPM-bound certificate; `pg_ident.conf` maps certificate DNs to database roles.

```nix
# On the PostgreSQL instance:
seed.services.postgresql = {
  enable = true;
  databases.myapp = {
    clients.api = { role = "myapp_rw"; };                        # same namespace
    clients.worker = { role = "myapp_ro"; namespace = "s-xyz"; }; # cross-namespace
  };
};
```

The module handles:
- TLS server certificate via TPM-bound SPIFFE identity
- `pg_hba.conf` with cert auth per declared database
- `pg_ident.conf` mapping certificate DN → PostgreSQL role
- Automatic database and role creation via `seed-pg-init`

### Zitadel (`seed.services.zitadel`)

OIDC identity provider for user authentication across seed instances. Runs Zitadel v4 behind an mTLS proxy to the shared PostgreSQL.

```nix
# On the Zitadel instance:
seed.services.zitadel = {
  enable = true;
  hostname = "id.loom.farm";
  database.host = "postgres.s-gaydazldmnsg.svc.cluster.local";
};
```

The module handles:
- socat + openssl mTLS proxy for PostgreSQL (Go can't use TPM-bound keys natively)
- Master encryption key generation and persistence
- Schema initialization via `init zitadel` + `start-from-setup` (no admin DB access needed)
- Runs as dedicated `zitadel` system user

Instance authors pair it with Caddy for TLS ingress:

```nix
services.caddy = {
  enable = true;
  dataDir = "/var/lib/caddy";
  configFile = pkgs.writeText "Caddyfile" ''
    { acme_ca {$SEED_ACME_URL} }
    {$SEED_FQDN}, id.loom.farm { reverse_proxy localhost:8080 }
  '';
};
systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";
```

### mTLS proxy pattern

Both PostgreSQL and Zitadel modules use the same pattern for connecting to services that require client certificate authentication with TPM-bound keys:

```
Instance app → plaintext → socat (localhost:port)
  → openssl s_client -starttls postgres -cert /seed/tls/cert.pem -key /seed/tls/key.pem
  → mTLS → remote service
```

The TPM-bound key (`/seed/tls/key.pem`) is a TSS2 PRIVATE KEY — the actual key material never leaves the TPM. OpenSSL's `tpm2` provider handles all private key operations on-chip. This is transparent to the application connecting to localhost.

## Instance authoring notes

Instances run NixOS inside Kata VMs with `boot.isContainer = true`. This keeps closures small but has some side effects.

**RuntimeDirectory**: Some services expect `/run/<name>/` to exist. Since `boot.isContainer` skips some tmpfiles setup, add it explicitly:

```nix
systemd.services.myapp.serviceConfig.RuntimeDirectory = "myapp";
```

**Storage ownership**: PVC filesystems are root-owned by default. Set `user` and `group` on the storage entry:

```nix
seed.storage.data = { size = "1Gi"; user = "myapp"; group = "myapp"; };
```

**No kubectl exec**: Kata VMs don't support `kubectl exec`. Debug via service APIs, port-forward, or write diagnostics to storage.

**Environment variables**: k8s-injected env vars are captured at `/run/seed/env` during activation. Use `EnvironmentFile` in systemd services:

```nix
systemd.services.myapp.serviceConfig.EnvironmentFile = "/run/seed/env";
```

**Firewall**: The NixOS firewall is active inside the VM. `seed.expose` automatically opens declared ports. If you expose additional ports outside of `seed.expose`, open them manually:

```nix
networking.firewall.allowedTCPPorts = [ 9090 ];
```

## Examples

Each example is available as a template (`nix flake init -t git+ssh://silo.loom.farm/seed.git#<name>`). All use this `flake.nix` — change the module path and seed name as needed:

```nix
{
  inputs.seed.url = "git+ssh://silo.loom.farm/seed.git";
  inputs.nixpkgs.follows = "seed/nixpkgs";

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkSeed { name = "web"; module = ./web.nix; };
  };
}
```

### Caddy reverse proxy with TLS and custom domain (`instance-caddy`)

Caddy proxies HTTPS to a Node.js backend. The platform ACME endpoint provides Let's Encrypt certificates automatically. The flake registers a custom domain and the instance claims DNS names on it. Note the `{$VAR}` syntax — this is Caddy's env var expansion, not nix interpolation.

```nix
# flake.nix
{
  inputs.seed.url = "git+ssh://silo.loom.farm/seed.git";
  inputs.nixpkgs.follows = "seed/nixpkgs";

  outputs = { seed, ... }: {
    combine.domains."example.com" = { register = true; default = true; };
    seeds.web = seed.lib.mkSeed { name = "web"; module = ./web.nix; };
  };
}
```

```nix
# web.nix
{ pkgs, ... }:

let
  app = pkgs.writeShellScript "app" ''
    while true; do
      echo -e "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHello from Seed!" | \
        ${pkgs.busybox}/bin/nc -l -p 3000 -q 0
    done
  '';
in {
  seed.expose.https.enable = true;
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };
  seed.dns.names = [ "example.com" "www.example.com" ];

  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN}, example.com, www.example.com {
        reverse_proxy localhost:3000
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";

  systemd.services.app = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = app;
    serviceConfig.Restart = "always";
  };
}
```

### Static site with nginx (`instance`)

No TLS — serves plain HTTP on port 80. Good for behind-a-proxy setups or internal services.

```nix
# web.nix
{ pkgs, ... }:

{
  seed.expose.http.enable = true;
  seed.storage.data = "1Gi";

  services.nginx.enable = true;
  services.nginx.virtualHosts.default = {
    listen = [{ addr = "0.0.0.0"; port = 80; }];
    root = "/seed/storage/data/www";
  };
}
```

### DNS server

PowerDNS authoritative nameserver. The `dns` protocol exposes both TCP and UDP on port 53 automatically.

```nix
# dns.nix
{ config, pkgs, ... }:

{
  seed.size = "s";
  seed.expose.dns.enable = true;
  seed.expose.api = { port = 8081; };
  seed.storage.data = "1Gi";

  sops.defaultSopsFile = ./secrets/dns.yaml;
  sops.secrets.pdns-api-key = {};

  services.powerdns = {
    enable = true;
    extraConfig = ''
      launch=gsqlite3
      gsqlite3-database=/seed/storage/data/pdns.db
      local-address=0.0.0.0, ::
      local-port=53
      api=yes
      api-key-file=${config.sops.secrets.pdns-api-key.path}
      webserver=yes
      webserver-address=0.0.0.0
      webserver-port=8081
      webserver-allow-from=0.0.0.0/0
      socket-dir=/run/pdns
    '';
  };

  systemd.services.pdns.serviceConfig.RuntimeDirectory = "pdns";
  systemd.tmpfiles.rules = [ "d /seed/storage/data 0755 pdns pdns -" ];
}
```

### App with secrets (`instance-api`)

A Node.js app that reads an API key from sops-nix. Secrets are encrypted with the instance's TPM-backed age key — see [Secrets](#secrets) for the provisioning flow.

```nix
# api.nix
{ config, pkgs, ... }:

let
  app = pkgs.writeShellScript "api-server" ''
    API_KEY=$(cat /run/secrets/api-key)
    ${pkgs.nodejs}/bin/node -e "
      const http = require('http');
      const key = process.env.API_KEY || require('fs').readFileSync('/run/secrets/api-key', 'utf8').trim();
      http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('ok');
      }).listen(3000);
    "
  '';
in {
  seed.expose.myapp = { port = 3000; };
  seed.storage.data = "1Gi";

  sops.defaultSopsFile = ./secrets/api.yaml;
  sops.secrets.api-key = {};

  systemd.services.api = {
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = app;
      Restart = "always";
    };
  };
}
```

### Multiple instances (`multi`)

A web frontend and API backend sharing a namespace. Each instance is a separate VM with its own resources.

```nix
# flake.nix
{
  inputs.seed.url = "git+ssh://silo.loom.farm/seed.git";
  inputs.nixpkgs.follows = "seed/nixpkgs";

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkSeed { name = "web"; module = ./web.nix; };
    seeds.api = seed.lib.mkSeed { name = "api"; module = ./api.nix; };
  };
}
```

```nix
# web.nix — Caddy frontend, proxies /api to the api instance
{ pkgs, ... }:

{
  seed.expose.https.enable = true;
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN} {
        handle /api/* {
          reverse_proxy api:3000
        }
        handle {
          root * /seed/storage/data/www
          file_server
        }
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";
  seed.storage.data = "1Gi";
}
```

```nix
# api.nix — Node.js API backend
{ pkgs, ... }:

let
  server = pkgs.writeShellScript "api" ''
    ${pkgs.nodejs}/bin/node -e "
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'ok'}));
      }).listen(3000);
    "
  '';
in {
  seed.expose.myapi = { port = 3000; };

  systemd.services.api = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = server;
    serviceConfig.Restart = "always";
  };
}
```

---

## Technical reference

Optimized for agents. Everything needed to deploy an instance from scratch.

### Deploy sequence

```
1.  nix flake init -t git+ssh://silo.loom.farm/seed.git#instance-caddy
2.  Edit web.nix (NixOS config with seed.* options)
3.  Create .authorized_keys (your SSH public key)
4.  nix eval .#seeds.web.meta --json              # validate
5.  git init && git add -A && git commit -m "initial"
6.  git remote add origin silo.loom.farm:my-app.git
7.  git push -u origin master                      # creates repo on silo
8.  nix run git+ssh://silo.loom.farm/seed.git#seed-plant -- silo:my-app <invite-code>
9.  git add .seed-identity && git commit -m "add identity" && git push
10. ssh seed.loom.farm status                      # verify
```

Subsequent deploys: `git push` triggers automatic reconciliation via webhook.

### Environment variables

See [Environment variables](#environment-variables) for the full table. Access via `EnvironmentFile = "/run/seed/env"` — systemd strips inherited env in Kata VMs.

### Well-known paths

| Path | Description |
|------|-------------|
| `/seed/storage/<name>` | Persistent volume mount (default) |
| `/seed/tpm/age-identity` | TPM-backed age key for sops-nix |
| `/run/seed/env` | k8s-injected env vars (source this) |
| `/run/current-system` | NixOS system closure |

### Content-addressed deployments

Same nix config produces the same store paths, which produces the same generation hash. The controller skips reconciliation entirely when nothing changed. If the store path didn't change, the pod won't restart.

### Errors surface at three stages

1. **Eval** (`nix eval`): NixOS option type errors. Immediate, precise tracebacks.
2. **Build** (`nix build`): Derivation failures (missing deps, compile errors). After eval succeeds.
3. **Runtime**: systemd service failures inside the VM. Use `ssh seed.loom.farm logs <instance>` or expose a health endpoint.

Most errors are caught at stage 1.

### Seed shell commands

```
(no command)                   interactive TUI dashboard (requires TTY)
plant <uri> <code> [<sig>]     register a repo (silo:name, github:user/repo)
replant <identity> <new-uri>   change source URI (identity preserved)
status [repo] [-w N]           instance status (watch mode: refresh every Ns)
logs <[repo/]instance>         logs (flags: -f, --lines N, --json)
restart <[repo/]instance>      restart an instance
keys <[repo/]instance>         show age public key (for sops encryption)
help                           show usage
```

### Silo flake URI formats

```
silo:my-app                    → tarball+https://silo.loom.farm/my-app/archive/master.tar.gz
github:user/repo               → passed through to nix
git+https://...                → passed through to nix
```

### Instance option summary

```nix
seed.size = "xs";                    # xs|s|m|l|xl — VM sizing tier
seed.expose.<name>.enable = true;   # well-known: port/protocol from service table
seed.expose.<name> = { port; protocol; }; # custom: specify explicitly
seed.expose.<name> = port;          # bare port shorthand
seed.dns.names = [ "example.com" ]; # custom DNS names (must match combine.domains)
seed.storage.<name> = "1Gi";        # or { size; mountPoint; user; group; mode; }
seed.rollout = "recreate";          # or "rolling"
seed.acme = true;                   # auto-detected from expose protocols
seed.shoot.enable = false;          # ephemeral VM forking
```

### Gotchas

- `RuntimeDirectory` must be set explicitly for services needing `/run/<name>/`
- PVC mounts are root-owned — set `user`/`group` on `seed.storage` entries for non-root services
- No `kubectl exec` in Kata VMs — debug via logs, port-forward, or storage
- Use `EnvironmentFile = "/run/seed/env"` for SEED_* env vars in systemd services
- Persist `/var/lib/acme` via `seed.storage` to avoid LE rate limits on redeploy
- `nix eval .#seeds.<name>.meta --json` is the fast feedback loop — use it before every push

## License

MIT
