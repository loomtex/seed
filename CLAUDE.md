# CLAUDE.md

## Overview

Seed is a NixOS module that bundles k3s + nix-snapshotter + Kata Containers into a single `seed.enable = true` import. Every pod gets hardware VM isolation via Kata — this is multi-tenant infrastructure.

## File structure

```
seed/
├── flake.nix              # Inputs, overlays, module/template exports
├── module.nix             # seed.* NixOS options and config
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

### kata-runtime overlay (in flake.nix)

Upstream `kata-runtime` nixpkg builds both QEMU and CLH configuration files, but only includes QEMU binary in the derivation output. The CLH config (`configuration-clh.toml`) hardcodes a path to `cloud-hypervisor` inside the kata-runtime store path, where it doesn't exist.

The overlay patches `configuration-clh.toml` to point to the actual `cloud-hypervisor` package binary.

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

## Roadmap

- ArgoCD plugin for rendering nix flakes → k8s manifests
- Service connectivity between instances (NetworkPolicy / service mesh)
- Dogfooding: seed's own services run on seed
- Multi-server HA via embedded etcd (`--cluster-init`)
- `nix flake init -t github:loomtex/seed` end-to-end onboarding
