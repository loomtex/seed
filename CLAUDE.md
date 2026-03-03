# CLAUDE.md

## Overview

Seed is a NixOS module that bundles k3s + nix-snapshotter + Kata Containers into a single `seed.enable = true` import. Every pod gets hardware VM isolation via Kata — this is multi-tenant infrastructure.

## File structure

```
seed/
├── flake.nix              # Inputs, overlays, module/template exports
├── module.nix             # seed.* NixOS options and config (node-level)
├── instance.nix           # seed.* instance options (size, expose, storage, connect)
├── instance-base.nix      # Stripped NixOS profile for Kata VM guests
├── controller.nix         # seed.controller.* NixOS module (systemd service)
├── controller.sh          # Reconciliation loop (bash)
├── persistence.nix        # Impermanence integration for /var/lib/rancher
├── vm.nix                 # NixOS VM configuration for testing
├── lib/
│   ├── mkInstance.nix     # Build a Seed instance from a NixOS module
│   └── mkImage.nix        # OCI image from a Seed instance (nix-snapshotter)
├── README.md
├── CLAUDE.md
├── LICENSE
├── .gitignore
└── templates/
    ├── default/           # nix flake init template (node)
    │   ├── flake.nix
    │   └── configuration.nix
    └── instance/          # nix flake init template (instance)
        ├── flake.nix
        └── web.nix
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

# Build an instance image
nix build .#seeds.x86_64-linux.web.image

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

### Instance options

Implemented in `instance.nix`, these options live in a separate NixOS evaluation from the node module:

| Option | Purpose |
|--------|---------|
| `seed.size` | VM sizing tier: xs (1/512MB), s (1/1GB), m (2/2GB), l (4/4GB), xl (8/8GB) |
| `seed.expose` | Ports to expose via k8s service. Accepts bare port or `{ port, protocol }` |
| `seed.storage` | Persistent volumes. Accepts size string or `{ size, mountPoint }` |
| `seed.connect` | Service discovery. Accepts service name or `{ service, port }` |
| `seed.meta` | Read-only computed metadata for controller consumption |

`seed.meta` denormalizes all options into a flat structure the controller reads via `nix eval --json`. It includes `resources` (vcpus/memory from size tier), and the expose/storage/connect maps.

### Instance image bridge (`lib/mkImage.nix`)

Wraps `pkgs.nix-snapshotter.buildImage` to produce an OCI image from a `mkInstance` result:

- Creates an FHS rootfs scaffold (proc, sys, dev, run, tmp, etc, var, nix/store)
- Symlinks `${toplevel}` to `/run/current-system`
- Sets entrypoint to `${toplevel}/init`
- Uses `resolvedByNix = false` — Kata shares rootfs via virtiofs, and nix-snapshotter's bind-mount resolution doesn't survive the host→VM boundary. The image contains the full NixOS closure.

The image ref format is `nix:0/nix/store/...-seed-<name>` which nix-snapshotter resolves.

### Controller

A bash-based systemd service (`controller.sh` + `controller.nix`) that runs on the seed node with direct access to nix and kubectl.

**Reconciliation loop:**

1. Lists instance names from `seeds.<system>` in the flake
2. Builds each instance's OCI image via `nix build`
3. Computes a generation hash (sha256 of sorted name=storepath pairs)
4. Skips if the deployed generation matches (content-addressed — same closures = no-op)
5. For each instance: evaluates metadata, applies PVCs, pod (with Kata annotations), and service
6. Reaps seed-managed resources with non-matching generation (except PVCs)

**Label scheme** — every resource gets:
```
seed.loomtex.com/managed-by: seed
seed.loomtex.com/instance: <name>
seed.loomtex.com/generation: <hash>
```

**Stateless**: all state lives in k8s labels. The generation hash is content-addressed from image store paths — the controller reads deployed generation from existing pod labels at each loop.

**Pod updates**: pods are immutable. If an instance's image ref changes, the controller deletes the old pod before applying the new one.

**Reaping**: after applying all instances, resources with a non-matching generation hash are deleted. PVCs are exempt to protect persistent data.

**Manifest generation**: done in bash with `jq`, not nix. Generation hashes are runtime values that would create an impedance mismatch in nix eval.

### Why not ArgoCD?

ArgoCD assumes YAML/Helm/Kustomize in → k8s manifests out. Seed's unit of deployment is a NixOS closure, not a manifest. A nix eval + build step doesn't fit ArgoCD's render pipeline without fighting it. A purpose-built controller is simpler and can own the full lifecycle: eval → build → deploy → activate → prune.

### Design principles

- **NixOS is the module system** — don't reinvent it
- **Kata is always on** — every instance gets hardware VM isolation (multi-tenant)
- **NixOS activation for lifecycle** — `switch-to-configuration` handles service management
- **Content-addressed generations** — same closures = same hash = no-op reconciliation
- **Label-based ownership** — controller tracks what it deployed, prunes what's removed
- **Sandboxed eval** — tenant flakes are untrusted code, eval in a restricted sandbox (future)

## Roadmap

- ~~Instance module (`seed.expose`, `seed.storage`, `seed.connect`, `seed.size`)~~ ✓
- ~~Seed controller (nix eval + build + pod reconciler)~~ ✓
- ~~Image bridge (mkImage wrapping nix-snapshotter buildImage)~~ ✓
- Sandboxed nix evaluation for untrusted tenant flakes
- Service connectivity between instances (DNS / env var injection)
- Multi-server HA via embedded etcd (`--cluster-init`)
- CRD-based instance definitions (SeedInstance custom resource)
- Dogfooding: seed's own services run on seed
