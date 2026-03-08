# Seed

Run NixOS systems in VM-isolated pods. No images to build. No registry to push to. Write a NixOS module, `git push`, and it boots in a hardware-isolated microVM via [Kata Containers](https://katacontainers.io/).

There's no `docker build`, no Dockerfile, no image registry. Your flake *is* the deployment artifact — the platform evaluates it directly and resolves nix store paths on the node. The entire Docker image lifecycle (build, tag, push, pull, layer caching) simply doesn't exist.

Each instance is a full NixOS system — use `services.nginx`, `services.postgresql`, `services.openssh`, whatever you'd put in a NixOS config. Seed adds a thin `seed.*` module for platform glue: sizing, ports, storage, secrets.

## Quick start

```bash
nix flake init -t github:loomtex/seed#instance
```

This creates a flake with a single web instance:

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
  seed.size = "s";
  seed.expose.http = 8080;
  seed.storage.data = "1Gi";

  services.nginx.enable = true;
  services.nginx.virtualHosts.default = {
    listen = [{ addr = "0.0.0.0"; port = 8080; }];
    root = "/seed/storage/data/www";
  };
}
```

Push this to a git repo and point a Seed node at it. The controller evaluates your flake, builds the NixOS closure on the node, and boots it in a Kata VM — nginx running, persistent volume mounted, port exposed. No build pipeline needed.

## Instance options

These are the `seed.*` options available inside instance modules.

### `seed.size`

VM sizing tier. Defaults to `"s"`.

| Tier | vCPUs | Memory |
|------|-------|--------|
| `xs` | 1 | 512 MB |
| `s` | 1 | 1 GB |
| `m` | 2 | 2 GB |
| `l` | 4 | 4 GB |
| `xl` | 8 | 8 GB |

### `seed.expose`

Ports to expose via k8s Service. Accepts a bare port number (defaults to `protocol = "http"`) or an attrset with `port` and `protocol`.

Protocols: `tcp`, `udp`, `dns` (both TCP+UDP), `http`, `grpc`.

```nix
seed.expose.http = 8080;                          # shorthand
seed.expose.dns = { port = 53; protocol = "dns"; }; # explicit
seed.expose.grpc = { port = 9090; protocol = "grpc"; };
```

### `seed.storage`

Persistent volumes. Accepts a size string (mounted at `/seed/storage/<name>`) or an attrset with `size` and `mountPoint`.

```nix
seed.storage.data = "1Gi";                                      # → /seed/storage/data
seed.storage.cache = { size = "500Mi"; mountPoint = "/tmp/cache"; }; # custom mount
```

Storage survives pod restarts and redeployments. The underlying PVCs are never garbage-collected.

### `seed.connect`

Service discovery for other instances in the same namespace. Populates environment variables and files:

```nix
seed.connect.redis = "my-redis";
seed.connect.db = { service = "postgres"; port = 5432; };
```

This creates:
- `$SEED_REDIS_HOST` → `my-redis`
- `/etc/seed/connect/redis` → `my-redis`
- `$SEED_DB_HOST` → `postgres`
- `/etc/seed/connect/db` → `postgres:5432`

### `seed.rollout`

Deployment strategy. `"recreate"` (default) stops the old pod before starting the new one — safe for stateful services. `"rolling"` starts the new pod first for zero-downtime updates.

## Secrets

Instances get a virtual TPM device backed by [swtpm](https://github.com/stefanberger/swtpm) on the host. On first boot, a TPM-backed [age](https://github.com/FiloSottile/age) identity is generated at `/seed/tpm/age-identity`. Use this with [sops-nix](https://github.com/Mic92/sops-nix) for encrypted secrets:

```nix
{ config, ... }:

{
  sops.defaultSopsFile = ./secrets/myapp.yaml;
  sops.secrets.api-key = {};

  services.myapp.environmentFile = config.sops.secrets.api-key.path;
}
```

The provisioning flow:

1. Deploy the instance without secrets. It boots and generates a TPM identity.
2. Read the public key (the `age1tpm1q...` recipient) from the instance's TPM identity PVC.
3. Encrypt your secrets file with that recipient: `sops --age 'age1tpm1q...' secrets/myapp.yaml`
4. Redeploy. sops-nix decrypts via the vTPM automatically.

`sops.age.keyFile` defaults to `/seed/tpm/age-identity` — no extra configuration needed.

## Multiple instances

A flake can export any number of instances. They share a k8s namespace derived from the flake URI.

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

Instances discover each other via `seed.connect`:

```nix
# api.nix
{
  seed.connect.db = "seed-db";  # k8s service name
  # ...
}
```

## Instance authoring notes

Instances run NixOS inside Kata VMs with `boot.isContainer = true`. This keeps closures small but has some side effects to be aware of.

**RuntimeDirectory**: Some services expect `/run/<name>/` to exist. Since `boot.isContainer` skips some tmpfiles setup, add it explicitly:

```nix
systemd.services.myapp.serviceConfig.RuntimeDirectory = "myapp";
```

**Storage ownership**: PVC filesystems are root-owned. If your service runs as a non-root user, chown the mount point:

```nix
systemd.tmpfiles.rules = [ "d /seed/storage/data 0755 myapp myapp -" ];
```

**No kubectl exec**: Kata VMs don't support `kubectl exec`. Debug via service APIs, port-forward, or write diagnostics to a PVC mount.

**Firewall**: The NixOS firewall is active inside the VM. `seed.expose` automatically opens declared ports. If you expose additional ports outside of `seed.expose`, open them manually:

```nix
networking.firewall.allowedTCPPorts = [ 9090 ];
```

## Hosting

To run your own Seed node, see [HOSTING.md](HOSTING.md).

## License

MIT
