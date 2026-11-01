# CLAUDE.md

## Overview

Seed is a NixOS module that bundles k3s + nix-snapshotter + Kata Containers into a single `seed.enable = true` import. Every pod gets hardware VM isolation via Kata — this is multi-tenant infrastructure.

## File structure

```
seed/
├── flake.nix              # Inputs, overlays, module/template exports, packages
├── module.nix             # seed.* NixOS options and config (node-level)
├── instance.nix           # seed.* instance options (size, expose, storage, connect)
├── instance-base.nix      # Stripped NixOS profile for Kata VM guests
├── controller.nix         # seed.controller.* NixOS module (k8s manifests)
├── controller.sh          # Legacy reconciliation loop (bash, replaced by src/)
├── persistence.nix        # Impermanence integration for /var/lib/rancher
├── vm.nix                 # NixOS VM configuration for testing
├── src/                   # TypeScript controller components
│   ├── shared/
│   │   ├── types.ts       # CRD types (SeedTPM, SeedDNSRecord, ...), metadata types
│   │   ├── labels.ts      # Label constants, helpers
│   │   └── kube.ts        # k8s client setup, helpers
│   ├── controller/
│   │   ├── index.ts       # Event-driven reconciliation loop
│   │   ├── builder.ts     # Builder Job creation/watching
│   │   ├── manifests.ts   # Deployment/Service/PVC generation
│   │   ├── routes.ts      # IPv4/IPv6 LB services
│   │   ├── metallb.ts     # MetalLB configuration
│   │   └── webhook.ts     # HTTP webhook handler
│   └── host-agent/
│       ├── index.ts       # main loop (netpol + upgrade agent, independent)
│       ├── netpol.ts      # per-node network policy (iptables)
│       ├── upgrade.ts     # node upgrade agent (Lease, cordon, drain, reboot)
│       ├── upgrade-logic.ts    # pure decisions (lease math, resume, drain filter)
│       └── upgrade-schedule.ts # pure bucket/jitter/tz window computation
├── package.json           # Node.js deps (@kubernetes/client-node)
├── tsconfig.json          # TypeScript config
├── build.mjs              # esbuild bundler script
├── patches/
│   ├── kata-multi-mount-rootfs.patch  # Kata shim: multi-mount rootfs + recursive bind
│   ├── kata-tpm-socket.patch          # Kata shim: TPM socket annotation for CLH vTPM
│   ├── kata-shim-swtpm.patch          # Kata shim: shim-owned swtpm (seed.loom.farm/tpm-*)
│   └── swtpm-seed-backend.patch       # swtpm seed:// backend (CephFS permall, create-gate)
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

- `boot.kernel.sysctl."net.ipv4.ip_forward" = 1` — pod networking (IPv4)
- `boot.kernel.sysctl."net.ipv6.conf.all.forwarding" = 1` — pod networking (IPv6)
- `boot.kernelModules = [ "vhost_net" "vhost_vsock" ]` — Kata VM devices
- `services.nix-snapshotter.enable = true` — nix store path resolution in images
- `services.k3s.enable = true` with Kata runtime in containerd config
- `systemd.services.k3s.path` — kata-runtime + hypervisor in service PATH
- `systemd.services.k3s.serviceConfig.DeviceAllow` — KVM + vhost device access
- RuntimeClass manifest auto-deployed via ExecStartPre (server role)
- MetalLB v0.15.3 manifest auto-deployed via ExecStartPre (server role)
- Optional `seed.k3s.dualStack` for IPv4+IPv6 cluster/service CIDRs

### Kata config patching

Three layers of patching:

**Multi-mount rootfs patch (`patches/kata-multi-mount-rootfs.patch`)**: Upstream kata-runtime only handles single-mount rootfs, but nix-snapshotter returns overlay + N bind mounts (one per nix store path). The patch fixes three issues in kata's Go shim:
1. `create.go`: Accept rootfs metadata when `len(Rootfs) >= 1` (was `== 1`)
2. `create.go`: Copy `Mount.Target` field in `doMount()` for subdirectory bind mount resolution (containerd uses Target to place bind mounts at `/nix/store/xxx` inside the rootfs)
3. `mount_linux.go`: Use `MS_BIND|MS_REC` in `bindMountContainerRootfs()` so nix store sub-mounts propagate through virtiofs into the guest VM

**CLH path fix (flake.nix overlay)**: Upstream `kata-runtime` nixpkg builds both QEMU and CLH configuration files, but only includes QEMU binary in the derivation output. The CLH config (`configuration-clh.toml`) hardcodes a path to `cloud-hypervisor` inside the kata-runtime store path, where it doesn't exist. The overlay patches `configuration-clh.toml` to point to the actual `cloud-hypervisor` package binary.

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
nix build .#seeds.web.image

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
  seed.dns.names = [ "loom.farm" ]; # Custom DNS names (AAAA + A records)
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
| `seed.expose` | Ports to expose via k8s service. Accepts bare port or `{ port, protocol }`. Protocols: `tcp`, `udp`, `dns` (both TCP+UDP), `http`, `grpc` |
| `seed.dns.names` | Custom DNS names (list of strings). Each gets AAAA + A records pointing at the instance's ingress IP. Zone apex names auto-generate wildcards. |
| `seed.storage` | Persistent volumes. Accepts size string or `{ size, mountPoint }` |
| `seed.connect` | Service discovery. Accepts service name or `{ service, port }` |
| `seed.meta` | Read-only computed metadata for controller consumption |

`seed.meta` denormalizes all options into a flat structure the controller reads via `nix eval --json`. It includes `resources` (vcpus/memory from size tier), and the expose/storage/connect maps.

### Instance image bridge (`lib/mkImage.nix`)

Wraps `pkgs.nix-snapshotter.buildImage` to produce an OCI image from a `mkInstance` result:

- Creates an FHS rootfs scaffold (proc, sys, dev, run, tmp, etc, var, nix/store)
- Symlinks `${toplevel}` to `/run/current-system`
- Sets entrypoint to `${toplevel}/init`
- Uses `resolvedByNix = true` — nix-snapshotter resolves store paths via bind mounts, and the patched kata-runtime propagates them through virtiofs into the guest VM via recursive bind mount (`MS_BIND|MS_REC`).

The image ref format is `nix:0/nix/store/...-seed-<name>` which nix-snapshotter resolves.

### Controller

Three k8s-native TypeScript components replace the legacy bash controller:

1. **seed-controller** (Deployment) — main reconciliation engine + webhook handler
2. **seed-host-agent** (DaemonSet) — privileged (hostNetwork, hostPID) pod enforcing per-node network policy and running the node upgrade agent (see "Node upgrades"); swtpm moved to the Kata shim. Netpol iptables rules survive host-agent restarts (shutdown leaves them; the next pod adopts them and prunes chains for vanished namespaces); starting with netpol disabled removes them.
3. **seed-builder** (Jobs) — nix build/eval in isolated pods

Written in TypeScript with `@kubernetes/client-node`. Bundled via esbuild, packaged as OCI images via `nix-snapshotter.buildImage`.

**CRD: SeedTPM** — one per TPM instance (`kubectl get stpm -A`), recording the TPM fingerprint the Kata shim verifies on every boot. SeedHostTask is retired (swtpm moved to the shim on 2026-11-01); the controller only reaps leftover objects.

**CRD: SeedDNSRecord** — DNS records as k8s resources. Two modes: **dynamic** (sourceRef to a Service, IP resolved from LoadBalancer status) and **static** (explicit records). The DNS reconciler watches SeedDNSRecords + ingress Services via informers, resolves IPs, and syncs to PowerDNS. Debounced 2s + 120s periodic full-sync as safety net. Blacklisted domains (.cluster.local, .local, .internal) get error status instead of syncing. `kubectl get sdr -A` shows all DNS records and their sync status.

**Namespace isolation**: each flake gets its own k8s namespace derived deterministically from the flake URI. `namespace = "s-" + base32(sha256(flake_uri))[:12]`. No flake can choose or influence its namespace — platform-enforced isolation. The `SEED_NAMESPACE` env var overrides this for dev/testing only.

**Two-level reconciliation:**

Level 1 — Generation reconciliation (on flake change):
1. Lists instance names via `nix eval`
2. Creates builder Jobs (one per instance, nix build + eval)
3. Waits for Jobs, reads results from ConfigMaps
4. Computes generation hash (sha256 of sorted name=storepath pairs)
5. Renders desired state, applies to cluster

Level 2 — Continuous self-healing (always running):
- Watches pods, services, PVCs via k8s API
- Recreates missing resources within seconds (e.g. pod deleted externally)
- Reaps old-generation resources (except PVCs)

**Label scheme** — every resource gets:
```
seed.loom.farm/managed-by: seed
seed.loom.farm/instance: <name>
seed.loom.farm/generation: <hash>
```

**Stateless**: all state lives in k8s labels. The generation hash is content-addressed from image store paths.

**Deployments**: each instance is a Deployment(replicas=1, strategy=Recreate). The k8s Deployment controller handles pod replacement on image changes, restarts on failure, and rolling updates. The controller just applies the desired Deployment spec — no manual pod lifecycle management.

**Pod template labels**: pod templates only carry `managed-by` and `instance` labels (no generation). This ensures that when one instance's image changes, only that instance's pods are rolled — unchanged instances are left alone even though the generation hash changed.

**Reaping**: after applying all instances, Deployments/Services/SeedHostTasks with a non-matching generation hash are deleted. PVCs are exempt to protect persistent data.

**Event-driven reconciliation**: the controller does NOT poll. It runs one reconciliation on startup, then waits for webhook events. Triggers (webhooks, plant/replant, retry timers) go into a per-flake work queue (`src/controller/reconcile-queue.ts`) that runs up to `SEED_RECONCILE_CONCURRENCY` (`seed.controller.reconcileConcurrency`, default 3) flakes at once. A flake never has two reconciles in flight; a trigger that lands mid-reconcile coalesces into exactly one re-run afterwards. Startup reconciles go through the same queue.

**Self-heal**: runs on a 60s timer independent of reconciliation. Checks that expected Deployments and Services exist and recreates any missing ones.

**Manifest generation**: done in TypeScript (replaces jq). Type-safe k8s manifests with `@kubernetes/client-node` types.

**Protocol handling**: the controller reads `.protocol` from each expose entry in metadata. `"dns"` generates both TCP and UDP service ports. `"udp"` generates UDP-only. Everything else generates TCP.

**Webhook**: HTTP server in the controller pod, Caddy reverse-proxies to it via k8s Service. HMAC-SHA256 verification for GitHub webhooks.

**Builder Jobs**: run on default runtime (not Kata — unix sockets don't traverse virtiofs). Mount host nix-daemon socket and nix store. Results delivered via ConfigMap.

**RBAC**: ClusterRole with access to namespaces, pods, pvcs, services, configmaps, jobs, runtimeclasses, metallb CRDs, SeedTPM CRDs, and leftover SeedHostTasks (reap only).

**Legacy**: `controller.sh` is preserved for reference but no longer used in production.

### IPv4 route block

Public ingress via a Vultr reserved IP. The flake exports an `ipv4` output that maps external ports to instance ports:

```nix
ipv4 = {
  enable = true;
  routes = {
    dns = { port = 53; protocol = "dns"; instance = "dns"; };
    # web = { port = 443; protocol = "tcp"; instance = "web"; targetPort = 8080; };
  };
};
```

Each route entry has: `port` (external), `protocol` (`tcp`/`udp`/`dns`/`http`/`grpc`), `instance` (target), and optional `targetPort` (defaults to `port`).

The controller groups routes by instance and creates one `LoadBalancer` service per instance (`seed-<instance>-ipv4`) with `loadBalancerIP` set to `SEED_IPV4_ADDRESS` and `externalTrafficPolicy: Local`. These are distinct from the ClusterIP services created by `seed.expose`.

The `seed.controller.ipv4Address` NixOS option passes the reserved IP as `SEED_IPV4_ADDRESS` to the controller.

IPv4 services are labeled with `seed.loom.farm/service-type: ipv4` and participate in generation-based reaping like all other resources.

### IPv6 route block

Same pattern as IPv4 but with a reserved /64 block. The flake exports an `ipv6` output:

```nix
ipv6 = {
  enable = true;
  block = "2001:19f0:6402:7eb::/64";
  routes = {
    dns = { host = "1"; port = 53; protocol = "dns"; instance = "dns"; };
  };
};
```

The `block` is the /64 prefix. Each route's `host` is the host portion (appended to the block prefix) — e.g. `host = "1"` with the above block yields `2001:19f0:6402:7eb::1`. This gives each route a dedicated IPv6 address from the block.

Services are created with `ipFamilies: ["IPv6"]` and `ipFamilyPolicy: SingleStack` so MetalLB assigns from the IPv6 pool.

### MetalLB

The seed module deploys MetalLB v0.15.3 via k3s auto-deploy manifests. k3s's built-in ServiceLB is disabled (it can't handle dual-stack — port conflicts when both IPv4 and IPv6 services bind the same host port).

The controller configures MetalLB on startup:
- Creates an `IPAddressPool` named `seed-pool` with both the IPv4 /32 and IPv6 /64 ranges
- Creates an `L2Advertisement` for ARP (IPv4) and NDP (IPv6) announcements
- Waits for MetalLB CRDs AND webhook endpoints before applying (race condition on fresh deploy)

All LoadBalancer services are annotated with `metallb.universe.tf/address-pool: seed-pool`.

### vTPM + sops-nix (instance secrets)

Each instance gets a vTPM device (`/dev/tpm0`) backed by swtpm on the host, enabling standard TPM-based secrets decryption via sops-nix + age-plugin-tpm.

**Architecture**: swtpm runs as a regular (non-Kata) pod per instance. Its socket is exposed via hostPath. CLH reads the socket path from the pod annotation `io.katacontainers.config.hypervisor.tpm_socket` and presents a TPM 2.0 CRB device to the guest.

**Kata patch** (`patches/kata-tpm-socket.patch`): Adds annotation-based TPM socket support to Kata's Go runtime. Modifies 5 files:
1. `hypervisor.go` — `TpmSocket` field on `HypervisorConfig`
2. `config.go` — TOML parsing + CLH config mapping
3. `clh.go` — Sets `vmconfig.Tpm` in `CreateVM()` when socket path is set
4. `annotations.go` — `tpm_socket` annotation constant
5. `utils.go` — Annotation-to-config mapping

**Controller lifecycle** (when `SEED_SWTPM_IMAGE` is set):
1. Creates `seed-<instance>-tpm` PVC (10Mi, persistent TPM state)
2. Deploys `seed-<instance>-tpm` pod (swtpm socket on hostPath `/run/swtpm/<ns>-<instance>/`)
3. Waits for swtpm pod Ready
4. Creates `seed-<instance>-tpm-identity` PVC (10Mi, persistent age key)
5. Applies instance pod with `tpm_socket` annotation pointing to swtpm socket

**Instance-side** (`instance-base.nix`):
- `age`, `age-plugin-tpm`, `tpm2-tools`, `sops` in system packages
- `seed-tpm-init` oneshot service: generates `/seed/tpm/age-identity` on first boot via `age-plugin-tpm --generate`
- sops-nix module imported via `mkInstance` — instances use standard `sops.secrets.*` options

**swtpm OCI image**: Built with `nix-snapshotter.buildImage`, available at `packages.x86_64-linux.swtpmImage`. Runs on default runtime (not Kata).

**Provisioning flow**:
1. First deploy — no secrets. Instance boots, `seed-tpm-init` creates TPM identity. Public key in `/seed/tpm/age-identity`.
2. Export public key (via kubectl port-forward or controller).
3. Encrypt secrets: `sops --age <recipient> secrets/dns.yaml`
4. Redeploy — sops-nix decrypts via TPM → `/run/secrets/*`

**Instance author experience** — standard sops-nix:
```nix
{ config, ... }: {
  sops.defaultSopsFile = ./secrets/dns.yaml;
  sops.age.keyFile = "/seed/tpm/age-identity";
  sops.secrets.api-key = {};
  services.powerdns.extraConfig = ''
    api-key-file=${config.sops.secrets.api-key.path}
  '';
}
```

**NixOS option**: `seed.controller.swtpmImage` — set to the swtpm image store path to enable vTPM for all instances.

### Shim-owned swtpm: runtime side (Kata shim, swtpm backend)

`patches/kata-shim-swtpm.patch` (kata fork branch `seed-shim-swtpm`, code in `virtcontainers/swtpm.go`) makes the Kata shim own one swtpm per sandbox, like virtiofsd. Pod annotations (passed through by containerd `pod_annotations = [..., "seed.loom.farm/tpm-*"]`):

- `seed.loom.farm/tpm-mode`: `create` | `verify` (absent → legacy `tpm_socket` path)
- `seed.loom.farm/tpm-state-dir`: e.g. `/var/lib/seed-controller/tpm/<ns>-<instance>`
- `seed.loom.farm/tpm-fingerprint`: lowercase hex SHA-256 (verify mode)

Before CLH starts, the shim: checks the sentinel (`seed.tpm.sentinelPath`, default `/var/lib/seed-controller/tpm/.seed-fs`) contains `seed.tpm.expectedFsid` (null → tpm-mode pods fail closed); takes an exclusive CephFS flock on `<state-dir>/.session-lock` (`seed.tpm.lockTimeout`, 120s; the fd is shared with swtpm so the lock lives as long as swtpm); starts swtpm (`SWTPM_SEED_ALLOW_CREATE=1` only in create mode; create refuses an existing permall); computes the fingerprint; writes `<state-dir>/tpm-fingerprint` (create, 64 hex chars, no newline) or compares with the annotation (verify). CLH then attaches to `/run/vc/vm/<sandbox>/swtpm.sock` and power-cycles the TPM itself (CMD_STOP + CMD_INIT). swtpm death after boot stops the VM.

**Fingerprint** = SHA-256 of the marshaled TPMT_PUBLIC (no TPM2B size prefix) of the owner-hierarchy SRK: ECC NIST P-256, SHA-256, `fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda|restricted|decrypt`, AES-128-CFB, scheme/kdf NULL, unique x/y = 32 zero bytes each. Reproduce with tpm2-tools (unique **must** come from stdin; `-u <file>` loads the raw C union and yields a zero-length unique):
```
head -c 64 /dev/zero | tpm2_createprimary -Q -C o -g sha256 -G ecc256:null:aes128cfb \
  -a 'fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda|restricted|decrypt' -u - -c srk.ctx
tpm2_readpublic -Q -c srk.ctx -o srk.pub && tail -c +3 srk.pub | sha256sum
```

**swtpm create-gate**: the `seed://` backend fails to load when `tpm2-00.permall` is missing unless `SWTPM_SEED_ALLOW_CREATE=1` (prevents silently manufacturing a TPM when CephFS is not mounted).

### Shim-owned swtpm: controller side

The Kata shim starts swtpm itself (the host agent no longer runs swtpm and only enforces network policy, so restarting it is safe). Creating a TPM is an explicit, controller-authorized event, verified on every boot. SeedHostTask is retired: the controller only reaps leftover objects.

- **Guest sees only `<state-dir>/guest`** (at `/seed/tpm`, holding `age-identity`), never the state dir: `tpm2-00.permall` is the TPM's unencrypted state and `tpm-fingerprint` is what the controller trusts. EST reads `guest/age-identity` first, then the root.
- **CephFS sentinel**: `/var/lib/seed-controller/tpm/.seed-fs` holds the Ceph fsid (`seed.tpm.expectedFsid`, from `infra/cluster.nix`). The controller (`assertTpmStorage`) and the shim both refuse to act on the state tree without it, because the mountpoint dir exists on every node and an unmounted CephFS looks like an empty tree. Write it once per cluster before deploying.
- **Pod annotations** (every TPM instance; there is no `tpm_socket` annotation): `seed.loom.farm/tpm-mode` = `create` | `verify`, `seed.loom.farm/tpm-state-dir` = `/var/lib/seed-controller/tpm/<ns>-<instance>`, `seed.loom.farm/tpm-fingerprint` (verify only).
- **SeedTPM** (`kubectl get stpm -A`, name = instance): `status.fingerprint` = lowercase hex SHA-256 of the SRK's marshaled TPMT_PUBLIC (owner hierarchy, ECC P-256 SRK template, unique = 2x32 zero bytes). If it's recorded, the instance is rendered in verify mode; if not, in create mode. A CEL rule makes it immutable. Deleting a SeedTPM (operator only, since the controller has no delete RBAC) is how you authorize a new TPM. SeedTPMs are never reaped.
- **Create → verify flip** (`src/controller/tpm.ts`): after a create-mode boot the shim writes `<state-dir>/tpm-fingerprint`. Once the pod is Ready, the controller validates the file, records it, and re-renders that Deployment in verify mode, which rolls the pod once. If the file and the record disagree, the controller logs it, emits a `FingerprintMismatch` event and sets the condition. It never rewrites the record.
- **Safety stop**: if an instance has host-agent-era state (`tpm2-00.permall` present, no `tpm-fingerprint`) and no record, its flake's reconcile fails rather than render create mode over it. Fix it with `tpm-backfill`.
- **Backfill**: run `nix run .#tpm-backfill -- --write-status <ns> <instance>` as root on a node. It records an existing state's fingerprint after verifying, on a scratch copy, that the age identity decrypts against it.

### Node upgrades (upgrade agent)

NixOS upgrades of the k3s nodes are serialized through a Kubernetes Lease so only one node upgrades at a time (3 embedded-etcd servers need 2 for quorum; a reboot kills that node's Kata VMs, which restart elsewhere as normal Deployment pods).

**Split of roles**:
- **Upgrade agent** (`src/host-agent/upgrade.ts`, inside the host-agent DaemonSet, privileged + hostPID) coordinates: Lease, cordon, drain, reboot trigger, health gate. Host commands run via `nsenter -t 1 -m -u -i -n -p -- /run/current-system/sw/bin/systemctl ...`.
- **Host unit** `seed-upgrade.service` (`infra/profiles/seed-upgrade.nix` + `.sh`, oneshot) does the work: resolves the infra flake to a pinned rev (`nix flake metadata --refresh`), `nixos-rebuild build --flake github:loomtex/seed/<rev>?dir=infra#<host> --refresh --option eval-cache false`, compares the built `kernel`/`initrd`/`kernel-modules` with `/run/booted-system` (the autoUpgrade allowReboot rule), logs whether `dry-activate` would restart `k3s.service`, then `nixos-rebuild boot` (reboot needed; activates nothing) or `switch`. Writes `/run/seed-upgrade/state` = `{"outcome": "switched"|"reboot-required"|"failed", "system", "time", "invocation", "error"?}`; exits non-zero on failure. It never reboots.

**Modes** — `seed.upgradeAgent.mode` (module.nix, same on every node; default `"dry-run"`), passed to the host agent as `SEED_UPGRADE_MODE`:
- `dry-run`: host `system.autoUpgrade` timer still upgrades (as before). At its window the agent pre-checks, acquires the Lease, logs the plan (cordon, unit, pods it would evict, current health gate), holds 1 min, releases. No cordon/trigger/drain/reboot.
- `active`: `system.autoUpgrade.enable = false` (no timer) and the agent runs the full flow. The DaemonSet env comes from the controller node's config, the timer toggle from each node's own config — switch all nodes.

**Schedule**: the agent computes it from the Node list, so the DaemonSet spec is identical everywhere: control-plane nodes (`node-role.kubernetes.io/control-plane`) by name, then the rest; bucket = index mod 4; local time 04:00 + 30 min × bucket + a fixed 0–10 min jitter from sha256(node name). `TZ` comes from the controller node's `time.timeZone` (ICU tz database, DST-correct). Only windows that start while the agent is running fire — missed windows don't catch up. `infra/profiles/seed-upgrade.nix` keeps the same rule for the autoUpgrade timer plus the "#servers ≤ buckets" assertion. On demand: `kubectl annotate node <n> seed.loom.farm/upgrade-now=true` runs the flow once (still Lease-gated); the agent removes the annotation when it starts.

**Lease** `seed-system/node-upgrade` (`leaseDurationSeconds` 1800, holder = node name):
- Pre-check: every control-plane node Ready with a heartbeat < 2 min old, else skip the window (Warning Event). Heartbeat = newer of the Ready condition's `lastHeartbeatTime` and the node's `kube-node-lease` renewTime — kubelet only rewrites an unchanged Ready condition every 5 min.
- Acquire: create; held by another and unexpired → retry every 60 s for up to 60 min; expired (renewTime + duration < now) or empty holder → take over with a resourceVersion-guarded update. Renewed every 60 s (errors tolerated). Release clears `holderIdentity` (rv-guarded, never someone else's).
- Lease annotations: `seed.loom.farm/upgrade-phase` = `upgrading` | `rebooting` | `held`, `upgrade-started` (validates the state file belongs to this run), `upgrade-boot-id` + `upgrade-reboot-attempts` (at reboot), `upgrade-hold-reason`.
- Node annotation `seed.loom.farm/upgrade-cordoned=true` is set only if the agent did the cordon; it only uncordons when that's present.

**Active flow**: preflight (unit loaded, not running) → acquire → cordon → phase=upgrading → `systemctl start --no-block seed-upgrade.service` → poll until done → read state:
- `switched` → health gate → uncordon (if ours) → release.
- `reboot-required` → drain → phase=rebooting + bootID → `systemctl reboot`.
- `failed` → Warning Event; health gate passes → uncordon + release; else hold.

**Drain**: policy/v1 Eviction of every pod on the node except DaemonSet-owned, mirror and finished pods; 429 (PDB) retried every 10 s; wait until gone; 15 min timeout → no reboot, Warning, hold. **Health gate**: every control-plane node (and this node) Ready + fresh, and `GET https://<InternalIP>:6443/readyz` with the SA token passes; then wait 2 min, re-check; up to 15 min, else hold.

**Resume on (re)start** (host-agent rollouts are RollingUpdate, so this is routine): if the Lease is ours — phase=rebooting with a new boot ID → health gate → uncordon → release; same boot ID → wait 5 min, re-issue the reboot once, then hold; phase=upgrading → keep polling the unit / continue from its outcome (missing or older state file = failed); phase=held → keep holding; no phase → uncordon (if ours) + release. Never starts a second upgrade while holding.

**Holding / manual intervention**: "hold" = keep renewing, do nothing (Warning Event `UpgradeHeld` on the Node, reason in the Lease). Fix the node, `kubectl uncordon <node>` if needed, then `kubectl delete lease node-upgrade -n seed-system` — the agent notices and stops holding. Check events with `kubectl get events -n default --field-selector involvedObject.kind=Node`. If a node finds itself cordoned by the agent without holding the Lease (Lease expired/taken over while it was down), it only emits `UpgradeOrphanedCordon`; uncordon by hand.

**Bypass**: `nixos-rebuild switch`/`boot` run by hand on a node (or starting `nixos-upgrade.service` / `seed-upgrade.service` directly) bypasses the Lease entirely — nothing stops two nodes being rebuilt together that way. Take the Lease's state into account first (`kubectl get lease node-upgrade -n seed-system -o yaml`).

**RBAC**: the host agent runs as the `seed-controller` ServiceAccount; the upgrade permissions are bound to it via ClusterRole `seed-upgrade-agent` (nodes get/list/watch/patch, pods list, pods/eviction create, events create/patch, `/readyz`), Role `seed-upgrade-agent` in seed-system (leases create; get/update/patch/delete on `node-upgrade`) and Role `seed-upgrade-agent` in kube-node-lease (leases get/list).

### Dual-stack networking

`seed.k3s.dualStack = true` adds `--cluster-cidr=10.42.0.0/16,fd00::/56` and `--service-cidr=10.43.0.0/16,fd01::/108` to k3s. The node must also have `--node-ip` set with both IPv4 and IPv6 addresses.

**Important**: existing pods from before dual-stack only have IPv4 IPs. They must be deleted and recreated to get dual-stack IPs (both IPv4 and IPv6). The flannel lease also needs re-registration — delete the node from kine (`/registry/minions/<name>`) if the node was created without dual-stack.

**IPv6 in instances**: services like PowerDNS must explicitly listen on `::` in addition to `0.0.0.0` to accept IPv6 traffic from the LoadBalancer.

### Instance authoring gotchas

Instances run NixOS inside Kata VMs with `boot.isContainer = true` (set in `instance-base.nix`). This strips kernel/initrd/bootloader for smaller closures, but has side effects:

**`/run` subdirectories**: `boot.isContainer` skips some tmpfiles setup. Services that need `/run/<name>/` directories (e.g. pdns needs `/run/pdns/` for its control socket) must set `systemd.services.<name>.serviceConfig.RuntimeDirectory = "<name>"` explicitly.

**No `kubectl exec`**: Kata VMs don't support `kubectl exec` (cgroup attach fails). Interact with services via their network APIs or k8s port-forward, not exec.

**No systemd journal in `kubectl logs`**: `kubectl logs` captures the container runtime's stdout/stderr pipe, not `/dev/console`. NixOS stage 2 boot messages appear (they go to console), but once systemd starts, its journal is internal. `ForwardToConsole` doesn't reach kubectl logs either. Debug via service APIs or readiness probes.

**PVC ownership**: PVC filesystems are root-owned by default. If a service runs as a non-root user (e.g. pdns runs as `pdns`), add a tmpfiles rule to chown the mount point: `systemd.tmpfiles.rules = [ "d /seed/storage/data 0755 pdns pdns -" ];`

**Schema initialization**: Use `ConditionPathExists` for one-shot DB init services, but be aware that if a previous bad run created the file with wrong permissions, the condition will skip re-init. To fix: delete the PVC and let it recreate, or add an `ExecStartPre` that fixes ownership.

**Nix flake caching**: The controller evaluates `github:loomtex/seed#seeds`. Nix caches flake lookups for ~1 hour (3600s TTL). After pushing changes, either run `nix eval ... --refresh` on the node, or wait for the cache to expire.

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
- ~~Namespace-per-flake isolation (hash-derived, platform-enforced)~~ ✓
- ~~UDP/DNS protocol support in instance module and controller~~ ✓
- ~~DNS instance (PowerDNS authoritative for loom.farm)~~ ✓
- ~~IPv4 route block (public ingress via Vultr reserved IP)~~ ✓
- ~~IPv6 route block (public ingress via reserved /64 block)~~ ✓
- ~~MetalLB dual-stack LoadBalancer (replaces k3s ServiceLB)~~ ✓
- ~~vTPM (swtpm + Kata TPM socket annotation + sops-nix + age-plugin-tpm)~~ ✓
- Sandboxed nix evaluation for untrusted tenant flakes
- Service connectivity between instances (DNS / env var injection)
- Multi-server HA via embedded etcd (`--cluster-init`)
- CRD-based instance definitions (SeedInstance custom resource)
- Dogfooding: seed's own services run on seed
