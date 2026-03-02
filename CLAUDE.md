# CLAUDE.md

## Overview

Seed is a NixOS module that bundles k3s + nix-snapshotter + Kata Containers into a single `seed.enable = true` import. Every pod gets hardware VM isolation via Kata — this is multi-tenant infrastructure.

## File structure

```
seed/
├── flake.nix              # Inputs, overlays, module/template exports
├── module.nix             # seed.* NixOS options and config (node-level)
├── persistence.nix        # Impermanence integration for /var/lib/rancher
├── vm.nix                 # NixOS VM configuration for testing
├── README.md
├── CLAUDE.md
├── LICENSE
├── .gitignore
└── templates/default/     # nix flake init template
    ├── flake.nix
    └── configuration.nix
```

## Module architecture

### `module.nix` — `config.seed.*`

When `seed.enable = true`, the module sets:

- `boot.kernel.sysctl."net.ipv4.ip_forward" = 1` — pod networking
- `boot.kernelModules = [ "vhost_net" "vhost_vsock" ]` — Kata VM devices
- `services.nix-snapshotter.enable = true` — nix store path resolution in images
- `services.k3s.enable = true` with Kata runtime in containerd config
- `systemd.services.k3s.path` — kata-runtime + hypervisor in service PATH
- `systemd.services.k3s.serviceConfig.DeviceAllow` — KVM + vhost device access
- RuntimeClass manifest auto-deployed via ExecStartPre (server role)

### Kata config patching

Two layers of patching:

**Overlay (flake.nix)**: Upstream `kata-runtime` nixpkg builds both QEMU and CLH configuration files, but only includes QEMU binary in the derivation output. The CLH config (`configuration-clh.toml`) hardcodes a path to `cloud-hypervisor` inside the kata-runtime store path, where it doesn't exist. The overlay patches `configuration-clh.toml` to point to the actual `cloud-hypervisor` package binary.

**VM sizing annotations (module.nix)**: Kata's upstream config only allows 3 annotations (`enable_iommu`, `virtio_fs_extra_args`, `kernel_params`). The module reads the upstream config via `builtins.readFile`, patches `enable_annotations` with `builtins.replaceStrings` to add `default_vcpus`, `default_memory`, `default_maxvcpus`, `default_maxmemory`, and drops it at `/etc/kata-containers/configuration.toml` (which kata checks before package defaults). This enables per-pod VM sizing via annotations like `io.katacontainers.config.hypervisor.default_vcpus: "4"`.

### containerdConfigTemplate format

k3s uses Go templates for containerd config. `{{ template "base" . }}` includes the default containerd configuration, then we append the Kata runtime block. The runtime type (`io.containerd.kata-clh.v2` or `io.containerd.kata-qemu.v2`) maps to the selected hypervisor.

### Service ordering

nix-snapshotter must be running before k3s starts (containerd needs the snapshotter plugin available). The module sets `after` + `wants` on k3s for `nix-snapshotter.service`.

### DeviceAllow rationale

- `/dev/kvm rwm` — hardware virtualization for Kata VMs
- `/dev/vhost-vsock rwm` — VM ↔ host communication channel
- `/dev/vhost-net rwm` — virtio networking for VMs
- `/dev/net/tun rwm` — TUN devices for pod networking
- `/dev/kmsg r` — kernel message buffer (k3s logging)

### Kernel modules

- `vhost_net` — in-kernel virtio-net backend (host networking for VMs)
- `vhost_vsock` — VM ↔ host socket communication (Kata agent protocol)
- `kvm` / `kvm_intel` / `kvm_amd` — expected to be loaded by hardware config

## Build / test

```bash
# Check flake
nix flake check

# Run test VM (requires KVM)
nix run .#vm

# Test in an existing NixOS config
nix flake lock --override-input seed path:/path/to/seed
nixos-rebuild build --flake . --show-trace
```

## Architecture: Seed instances

Seed is evolving from "k3s infrastructure module" to a platform where each **instance** is a full NixOS system running in a Kata microVM. The key insight: don't invent a new module system — use NixOS proper with a thin `seed.*` instance module for cloud glue.

### Instance model

A seed instance is a NixOS configuration that runs inside a Kata VM on the cluster. Users write standard NixOS modules (`services.nginx`, `services.postgresql`, etc.) and add seed-specific options for platform integration:

```nix
{ ... }: {
  seed.size = "medium";           # VM sizing (vCPUs, memory)
  seed.expose.http = 8080;        # Ingress routing
  seed.storage.data = "1Gi";      # Persistent volume
  seed.connect.redis = "my-redis"; # Service discovery

  services.nginx.enable = true;
  services.postgresql.enable = true;
  # ... standard NixOS config
}
```

### Instance options (planned)

| Option | Purpose |
|--------|---------|
| `seed.size` | VM sizing tier (maps to kata annotations for vCPUs/memory) |
| `seed.expose` | Ports to expose via ingress (HTTP, TCP, gRPC) |
| `seed.storage` | Persistent volumes (name → size) |
| `seed.connect` | Service discovery — consume other instances' exposed ports |

### Controller

A custom k8s controller (not ArgoCD) that:

1. **Watches** git repos or `SeedInstance` CRDs for changes
2. **Evals** NixOS configurations (sandboxed — tenant flakes are untrusted)
3. **Builds** NixOS closures (system.build.toplevel)
4. **Reconciles** Kata pods with matching closures, using label-based ownership for pruning

NixOS activation scripts handle lifecycle: `switch-to-configuration switch` does service start/stop/restart, user creation, etc. — the same battle-tested activation that NixOS uses on real machines.

### CRD sketch

```yaml
apiVersion: seed.loomtex.com/v1
kind: SeedInstance
metadata:
  name: my-app
spec:
  flakeRef: github:user/repo
  rev: abc123          # pin or "track branch"
  module: ./app.nix    # entry point in the flake
  size: medium
status:
  generation: 3
  ready: true
  lastEvalHash: sha256-...
  resources:
    vcpus: 4
    memory: 4Gi
```

### Why not ArgoCD?

ArgoCD assumes YAML/Helm/Kustomize in → k8s manifests out. Seed's unit of deployment is a NixOS closure, not a manifest. A nix eval + build step doesn't fit ArgoCD's render pipeline without fighting it. A purpose-built controller is simpler and can own the full lifecycle: eval → build → deploy → activate → prune.

### Design principles

- **NixOS is the module system** — don't reinvent it
- **Kata is always on** — every instance gets hardware VM isolation (multi-tenant)
- **NixOS activation for lifecycle** — `switch-to-configuration` handles service management
- **Label-based ownership** — controller tracks what it deployed, prunes what's removed
- **Sandboxed eval** — tenant flakes are untrusted code, eval in a restricted sandbox

## Roadmap

- Instance module (`seed.expose`, `seed.storage`, `seed.connect`, `seed.size`)
- Seed controller (git watcher + nix eval + pod reconciler)
- Sandboxed nix evaluation for untrusted tenant flakes
- Service connectivity between instances
- Multi-server HA via embedded etcd (`--cluster-init`)
- Dogfooding: seed's own services run on seed
