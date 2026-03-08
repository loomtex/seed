# Pool Manager Design

## Problem

The seed controller runs `nix eval` and `nix build` to process tenant flakes. These commands execute arbitrary Nix code — derivation fetchers, IFD (import-from-derivation), and custom evaluators. Running untrusted code in the controller pod (which has cluster-admin RBAC) is a security risk.

## Solution: Snapshot-based VM Pool

The pool manager maintains a pool of warm CLH (Cloud Hypervisor) VMs on each node. Each nix command runs inside a hardware-isolated VM with read-only access to the host nix store and proxied access to the nix daemon.

### Why CLH directly, not Kata?

Kata is a containerd shim — it translates OCI container semantics to VM semantics. Pool VMs don't need container semantics, image resolution, or k8s pod lifecycle. Running CLH directly gives us:
- Control over VM lifecycle (snapshot/restore)
- Sub-second restore from memory snapshots
- No Kata/containerd overhead

### Why not builder k8s Jobs?

Builder Jobs run in the controller's security context with access to the host nix-daemon socket. A CLH VM provides hardware isolation — untrusted tenant flake code runs in a separate VM with no cluster access.

## Architecture

### Snapshot Lifecycle

1. **Template boot**: Start a CLH VM with kernel + initramfs + vsock (no virtiofs)
2. **Pause + snapshot**: Guest init runs, sets up basics, pool manager pauses and snapshots
3. **Per-request**: Restore from snapshot → hotplug virtiofs → resume → run command → destroy
4. **Slot refill**: Copy golden snapshot back to slot directory

Key insight: snapshot WITHOUT virtiofs, hotplug AFTER restore. This avoids the CLH virtiofs snapshot/restore bug (cloud-hypervisor/cloud-hypervisor#6931).

### vsock Communication

Two channels per VM via CLH's vsock unix socket:
- **nix-daemon proxy** (guest port 6000): socat bridges vsock to host nix-daemon socket
- **command channel** (guest port 6001): one JSON request/response pair per VM lifetime

### Guest Init (Two-Phase)

Phase 1 (template boot): mount proc/sys/dev, signal ready via vsock
Phase 2 (after restore): mount virtiofs, set up PATH/env from nix store, run command

### Protocol

```
Request:  {"command":["nix","eval","..."],"env":{...},"timeout":120000}\n
Response: {"exitCode":0,"stdout":"...","stderr":"..."}\n
```

## Deployment

- **DaemonSet**: `seed-pool-manager` pod on each node (privileged, /dev/kvm access)
- **Service**: `seed-pool-manager:9877` for controller to call
- **Config**: `SEED_POOL_MANAGER_URL` env var on controller enables the pool path
