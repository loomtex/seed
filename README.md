# Seed

NixOS instances running in hardware-isolated microVMs. Write a NixOS module, push, and it boots on [seed.loom.farm](https://loom.farm) with automatic TLS, DNS, persistent storage, and encrypted secrets.

Each instance is a full NixOS system — `services.nginx`, `services.postgresql`, `services.openssh`, whatever you'd put in a NixOS config. Seed adds a thin `seed.*` module for platform glue.

If you're an AI agent deploying to Seed (or a human pointing one at it), skip to the [technical reference](#technical-reference).

## How it works

You write a nix flake that exports `seeds.<name>` for each instance. The platform evaluates your flake, builds the NixOS closure, and boots it in a [Kata Containers](https://katacontainers.io/) microVM. Every instance gets:

- **DNS**: `<instance>.<namespace>.seed.loom.farm` — resolves immediately
- **TLS**: Automatic Let's Encrypt certificates via the platform's embedded ACME server
- **Storage**: Persistent volumes that survive restarts and redeployments
- **Secrets**: A virtual TPM device for encrypted secrets via [sops-nix](https://github.com/Mic92/sops-nix)
- **Git hosting**: Push to [Silo](https://silo.loom.farm) — no GitHub account needed
- **Logs & management**: `ssh seed.loom.farm logs <instance>`, `status`, `restart`

There's no Docker, no image registry, no Helm, no YAML. NixOS is the abstraction.

## Getting started

### 1. Write a flake

```bash
nix flake init -t github:loomtex/seed#instance
```

This creates two files:

```nix
# flake.nix
{
  inputs.seed.url = "github:loomtex/seed";
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

### 3. Push and plant

Push your flake to a git remote. You can use Seed's built-in git hosting (Silo) or GitHub:

```bash
# Option A: Silo (built-in, no account needed)
git remote add origin silo.loom.farm:my-app.git
git push -u origin master

# Option B: GitHub
git remote add origin git@github.com:you/my-app.git
git push -u origin master
```

Then register your repo with an invite code:

```bash
# Silo-hosted repo
ssh seed.loom.farm plant silo:my-app <invite-code>

# GitHub-hosted repo
ssh seed.loom.farm plant github:you/my-app <invite-code>
```

The controller evaluates your flake, builds the NixOS closure, and boots the instance. Check status:

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

Persistent volumes. Accepts a size string (mounted at `/seed/storage/<name>`) or an attrset with `size` and `mountPoint`.

```nix
seed.storage.data = "1Gi";                                       # /seed/storage/data
seed.storage.cache = { size = "500Mi"; mountPoint = "/tmp/cache"; }; # custom mount
```

Storage survives pod restarts and redeployments. PVCs are never garbage-collected.

### `seed.rollout`

Deployment strategy. `"recreate"` (default) stops the old instance before starting the new one — safe for stateful services. `"rolling"` starts the new instance first for zero-downtime updates.

## TLS

Instances with `http` or `grpc` protocol in `seed.expose` get access to the platform's ACME facade — an RFC 8555 endpoint that proxies DNS-01 validation to Let's Encrypt. Your instance's web server requests certificates through it.

Your instance receives two environment variables:
- `SEED_ACME_URL` — the platform's ACME directory endpoint
- `SEED_FQDN` — your instance's hostname (e.g. `web.s-gaydazldmnsg.seed.loom.farm`)

Point your web server's ACME client at `SEED_ACME_URL`. Caddy is the easiest option — it handles ACME natively:

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

Caddy automatically obtains and renews TLS certificates from the platform ACME endpoint. The `{$SEED_ACME_URL}` and `{$SEED_FQDN}` variables are expanded from the environment at startup.

For nginx, use NixOS's `security.acme` module (which uses lego under the hood):

```nix
{ config, ... }:

let
  acmeServer = "http://seed-controller.seed-system.svc.cluster.local:9876/acme/directory";
in {
  seed.expose.http.enable = true;
  seed.expose.https.enable = true;
  seed.storage.acme = { size = "100Mi"; mountPoint = "/var/lib/acme"; };

  security.acme = {
    acceptTerms = true;
    defaults.server = acmeServer;
    defaults.email = "you@example.com";
  };

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

Certificates are real Let's Encrypt certs, browser-trusted. With nginx, persist `/var/lib/acme` via `seed.storage` to avoid hitting rate limits on redeployment. Caddy manages its own cert storage internally.

## DNS

Every instance is reachable at `<instance>.<namespace>.seed.loom.farm`. The namespace is derived deterministically from your flake URI — you don't choose it, but it's stable.

DNS records are created automatically when the instance deploys. No configuration needed.

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
  inputs.seed.url = "github:loomtex/seed";
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

All management happens over SSH at `seed.loom.farm`:

```bash
ssh seed.loom.farm status              # instance status across all your repos
ssh seed.loom.farm status my-repo      # status for a specific repo
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

## Instance authoring notes

Instances run NixOS inside Kata VMs with `boot.isContainer = true`. This keeps closures small but has some side effects.

**RuntimeDirectory**: Some services expect `/run/<name>/` to exist. Since `boot.isContainer` skips some tmpfiles setup, add it explicitly:

```nix
systemd.services.myapp.serviceConfig.RuntimeDirectory = "myapp";
```

**Storage ownership**: PVC filesystems are root-owned. If your service runs as a non-root user, chown the mount point:

```nix
systemd.tmpfiles.rules = [ "d /seed/storage/data 0755 myapp myapp -" ];
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

---

## Technical reference

Optimized for agents. Everything needed to deploy an instance from scratch.

### Deploy sequence

```
1. nix flake init -t github:loomtex/seed#instance
2. Edit web.nix (NixOS config with seed.* options)
3. Create .authorized_keys in repo root (your SSH public key)
4. nix eval .#seeds.web.meta --json              # validate
5. git init && git add -A && git commit -m "initial"
6. git remote add origin silo.loom.farm:my-app.git
7. git push -u origin master                      # creates repo on silo
8. ssh seed.loom.farm plant silo:my-app <invite>  # register with platform
9. ssh seed.loom.farm status                       # verify
10. ssh seed.loom.farm logs web                    # check logs
```

Subsequent deploys: `git push` triggers automatic reconciliation via webhook.

### Environment variables injected into instances

| Variable | When | Value |
|----------|------|-------|
| `SEED_FQDN` | always | `<instance>.<namespace>.seed.loom.farm` |
| `SEED_ACME_URL` | `seed.acme = true` | ACME directory URL for TLS certs |
| `SEED_SHOOT_URL` | `seed.shoot.enable = true` | Pool manager endpoint for ephemeral VMs |

Access via `EnvironmentFile = "/run/seed/env"` in systemd services (not `$ENV` — systemd strips inherited env in Kata VMs).

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
plant <flake-uri> <code>       register a repo (silo:name, github:user/repo)
status [repo]                  instance status + namespace + DNS names
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
seed.storage.<name> = "1Gi";        # or { size; mountPoint; }
seed.rollout = "recreate";          # or "rolling"
seed.acme = true;                   # auto-detected from expose protocols
seed.shoot.enable = false;          # ephemeral VM forking
```

### Gotchas

- `RuntimeDirectory` must be set explicitly for services needing `/run/<name>/`
- PVC mounts are root-owned — use `systemd.tmpfiles.rules` to chown for non-root services
- No `kubectl exec` in Kata VMs — debug via logs, port-forward, or storage
- Use `EnvironmentFile = "/run/seed/env"` for SEED_* env vars in systemd services
- Persist `/var/lib/acme` via `seed.storage` to avoid LE rate limits on redeploy
- `nix eval .#seeds.<name>.meta --json` is the fast feedback loop — use it before every push

## Why NixOS

Seed uses NixOS as the instance abstraction instead of containers. Every instance is a real NixOS system evaluated from a nix flake.

The full NixOS module ecosystem is available — `services.postgresql`, `security.acme`, `services.openssh`, `sops-nix` — with correct service dependencies, user management, and systemd lifecycle. Multi-service instances are just NixOS config.

The tradeoff is boot time (systemd startup, not millisecond cold starts). Seed isn't a function runtime — it's infrastructure.

Because NixOS is declarative, typed, reproducible, and introspectable, it is trivially wielded by modern LLMs. An agent can compose NixOS modules, debug systemd journals, and reason about option types without the friction a human faces. Nix is perfectly positioned to never be typed by a human again. Seed leans into that.

## License

MIT
