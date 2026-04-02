# Hosting a Seed Node

This document covers running your own Seed compute node — the infrastructure that runs instances. If you're writing instances (workloads), see the [README](README.md).

## Requirements

- NixOS (flakes enabled)
- KVM support (bare metal or nested virtualization)

## Quick start

```bash
nix flake init -t github:loomtex/seed
# edit configuration.nix if needed
nixos-rebuild switch --flake .
```

Or add to an existing flake:

```nix
{
  inputs.seed.url = "git+ssh://silo.loom.farm/seed.git";
  inputs.nixpkgs.follows = "seed/nixpkgs";

  outputs = { seed, nixpkgs, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        seed.nixosModules.default
        { seed.enable = true; }
        ./configuration.nix
      ];
    };
  };
}
```

## Node options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `seed.enable` | bool | `false` | Enable Seed compute node |
| `seed.hypervisor` | enum `[clh qemu]` | `"clh"` | Kata hypervisor backend |
| `seed.role` | enum `[server agent]` | `"server"` | k3s role (server = control plane + workloads, agent = workloads only) |
| `seed.serverAddr` | str | `""` | k3s server URL to join (required for agents) |
| `seed.token` | str | `""` | Cluster join token |
| `seed.tokenFile` | path \| null | `null` | File containing join token |
| `seed.k3s.port` | port | `6443` | API server HTTPS port |
| `seed.k3s.extraFlags` | list of str | `[]` | Additional k3s flags |
| `seed.k3s.disableDefaults` | list of enum | `[traefik servicelb metrics-server]` | Components to disable |
| `seed.k3s.kubeconfigMode` | str | `"644"` | kubeconfig file permissions |
| `seed.k3s.dualStack` | bool | `false` | Enable IPv4+IPv6 dual-stack networking |
| `seed.nixSnapshotter.enable` | bool | `true` | nix-snapshotter integration |
| `seed.persistence.enable` | bool | `false` | Persist /var/lib/rancher (impermanence) |
| `seed.persistence.path` | str | `"/persist"` | Impermanence mount point |

## Architecture

```
k3s → containerd → Kata runtime → Cloud Hypervisor → microVM
                  ↕
            nix-snapshotter (resolves nix store paths in images)
```

Every pod with `runtimeClassName: kata` runs inside a hardware-isolated VM. The hypervisor (CLH or QEMU) is configurable, but VM isolation is always on.

## Test a VM-isolated pod

```bash
kubectl run test --image=busybox --rm -it --restart=Never \
  --overrides='{"spec":{"runtimeClassName":"kata"}}' -- uname -a
# Shows Kata guest kernel, not host kernel
```

## Per-pod VM sizing

Kata annotations control vCPUs and memory per pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: large-worker
  annotations:
    io.katacontainers.config.hypervisor.default_vcpus: "4"
    io.katacontainers.config.hypervisor.default_memory: "4096"
spec:
  runtimeClassName: kata
  containers:
    - name: worker
      image: busybox
      command: ["sleep", "infinity"]
```

## Multi-node

k3s natively supports server + agent topology:

```nix
# First node (server)
{ seed.enable = true; }

# Additional nodes (agents)
{
  seed.enable = true;
  seed.role = "agent";
  seed.serverAddr = "https://server:6443";
  seed.tokenFile = "/run/secrets/k3s-token";
}
```

## Controller

The controller reconciles instance definitions into running Kata pods. It evaluates the flake, builds OCI images via nix-snapshotter, and applies k8s manifests.

### How it works

1. Lists instance names from `seeds` in the flake
2. Builds each instance's OCI image (`nix build ...#seeds.<name>.image`)
3. Computes a generation hash from the set of image store paths
4. Skips reconciliation if the deployed generation matches
5. Applies Deployments, PVCs, and Services with `seed.loom.farm/*` labels
6. Reaps resources with non-matching generation (except PVCs)

### Enable the controller

```nix
{
  imports = [
    seed.nixosModules.default
    seed.nixosModules.controller
  ];

  seed.enable = true;
  seed.controller = {
    enable = true;
    flakeUri = "github:you/your-flake";
  };
}
```

### Controller options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `seed.controller.enable` | bool | `false` | Enable the controller |
| `seed.controller.flakeUri` | str | required | Flake URI with `seeds.*` outputs |
| `seed.controller.ipv4Address` | str | `""` | Reserved IPv4 for LoadBalancer services |
| `seed.controller.swtpmImage` | str | `""` | swtpm OCI image store path (enables vTPM) |

## VM testing

Build and run a NixOS VM with Seed pre-configured:

```bash
nix run github:loomtex/seed#vm
```

The VM boots with k3s + Kata ready. Requires KVM on the host.

## Home Manager modules

For rootless k3s (per-user k3s instances), Seed re-exports nix-snapshotter's home-manager modules:

```nix
home-manager.users.myuser = {
  imports = [
    seed.homeModules.default
    seed.homeModules.k3s-rootless
  ];
};
```

## License

MIT
