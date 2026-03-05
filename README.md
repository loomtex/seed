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

## VM testing

Build and run a NixOS VM with Seed pre-configured:

```bash
nix run github:loomtex/seed#vm
```

The VM boots with k3s + Kata ready. Requires KVM on the host.

## Instances

A Seed instance is a full NixOS configuration that runs inside a Kata VM on the cluster. Write standard NixOS modules and add seed-specific options for platform integration.

### Quick start

```bash
nix flake init -t github:loomtex/seed#instance
# edit web.nix
nix build .#seeds.web.image
```

Or in an existing flake:

```nix
{
  inputs.seed.url = "github:loomtex/seed";

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkInstance {
      name = "web";
      module = ./web.nix;
    };
  };
}
```

### Instance module example

```nix
{ pkgs, ... }:

{
  seed.size = "m";
  seed.expose.http = 8080;
  seed.storage.data = "1Gi";
  seed.connect.redis = "my-redis";

  services.nginx.enable = true;
  services.nginx.virtualHosts.default = {
    listen = [{ addr = "0.0.0.0"; port = 8080; }];
    root = "/seed/storage/data/www";
  };
}
```

### Instance options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `seed.size` | enum `[xs s m l xl]` | `"s"` | VM sizing tier (see table below) |
| `seed.expose.<name>` | port or `{ port, protocol }` | `{}` | Ports to expose via k8s service |
| `seed.storage.<name>` | size string or `{ size, mountPoint }` | `{}` | Persistent volumes |
| `seed.connect.<name>` | service string or `{ service, port }` | `{}` | Service discovery for other instances |

### Size tiers

| Tier | vCPUs | Memory |
|------|-------|--------|
| `xs` | 1 | 512 MB |
| `s` | 1 | 1 GB |
| `m` | 2 | 2 GB |
| `l` | 4 | 4 GB |
| `xl` | 8 | 8 GB |

## Controller

The controller is a systemd service that reconciles instance definitions into running Kata pods. It evaluates the flake, builds OCI images via nix-snapshotter, and applies k8s manifests.

### How it works

1. Lists instance names from `seeds.<system>` in the flake
2. Builds each instance's OCI image (`nix build ...#seeds.<system>.<name>.image`)
3. Computes a generation hash from the set of image store paths
4. Skips reconciliation if the deployed generation matches
5. Applies pods, PVCs, and services with `seed.loomtex.com/*` labels
6. Reaps resources with non-matching generation (except PVCs)

Pods are immutable — if an instance's image changes, the controller deletes and recreates the pod.

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
    flakePath = "/path/to/your/flake";
  };
}
```

### Controller options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `seed.controller.enable` | bool | `false` | Enable the controller |
| `seed.controller.flakePath` | str | required | Path to flake with `seeds.*` outputs |
| `seed.controller.interval` | int | `30` | Reconciliation interval (seconds) |
| `seed.controller.namespace` | str | `"default"` | Kubernetes namespace |

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
