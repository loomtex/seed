# Seed

The Vercel for Nix derivations.

Push a nix flake, it runs in a VM-isolated pod. Every workload gets hardware-level isolation via [Kata Containers](https://katacontainers.io/) — this is multi-tenant by design.

Built on k3s + containerd + Kata + Cloud Hypervisor (or QEMU), with [nix-snapshotter](https://github.com/pdtpartners/nix-snapshotter) for native nix store path resolution in container images.

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
  inputs.seed.url = "github:loomtex/seed";
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

## Options

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
