# CLAUDE.md — Seed Infrastructure

## Overview

This directory contains the complete infrastructure for seed clusters:
NixOS machine configurations, cluster topology, secrets, and helper scripts.
It is a self-contained flake — everything needed to provision and manage
seed clusters from zero.

## Architecture: Agent-as-Orchestrator

There is no runbook, no Pulumi, no linear provisioning script. **You are the
orchestrator.** The key files are:

- `cluster.nix` — What should exist (hardware inventory, desired topology)
- `states.md` — How to get there (state model, transitions, detection rules)
- `.state/atl.md` — Where we are now (runtime state, tracked over time by git)

Read `cluster.nix` to know the desired end state. Read `states.md` to
understand the lifecycle transitions. Probe the actual infrastructure
(Vultr API, SSH) to determine current state. Then execute transitions
to close the gap.

## Reflective Provisioning

**states.md is a living document.** While provisioning, actively improve it:

- If a state transition needs an intermediate step you didn't expect → split it
- If detection logic doesn't work in practice → fix the detection rule
- If prerequisites are incomplete → add the missing guards
- If steps are misleadingly worded → reword them

After each provisioning run, propose changes to states.md. The goal is to
make each subsequent run smoother. Think of it like ansible playbooks made
entirely of comments — the intent is clear, the execution is intelligent,
and the documentation improves with every use.

## File Structure

```
infra/
├── flake.nix              # NixOS machine exports + devshell + helper apps
├── cluster.nix            # Hardware inventory + desired topology
├── states.md              # State model + transition definitions
├── CLAUDE.md              # This file — agent context
├── .sops.yaml             # Secret encryption rules
├── .gitignore
├── .state/                # Tracked in git — infrastructure state
│   └── atl.md             # ATL cluster state (IPs, Vultr IDs, status)
├── machines/
│   ├── atl/               # ATL cluster nodes
│   │   ├── seed-atl-1/    # k3s server, clusterInit, controller
│   │   ├── seed-atl-2/    # k3s server
│   │   └── seed-atl-3/    # k3s server
│   └── infra/             # Infrastructure machines
│       ├── seed-stake/    # Ephemeral provisioner VM
│       ├── seed-puncher-1/# Tang NBDE + DNS
│       └── seed-tang-1/   # Tang server (DFW, legacy)
├── profiles/
│   ├── server.nix         # Base server (nix flakes, common packages)
│   ├── seed-ceph.nix      # Ceph MON + MGR + OSD (dmcrypt) per node
│   ├── seed-cache.nix     # S3 binary cache (substituter + post-build-hook)
│   ├── seed-luks.nix      # LUKS + Clevis/Tang auto-unlock
│   ├── seed-vpc.nix       # Vultr VPC v1 static IP
│   └── seed-controller.nix# Controller shared secrets
├── data/
│   └── vpc.nix            # VPC IP allocations
├── secrets/               # sops-encrypted YAML files
├── helpers/               # Shell scripts (exposed as flake apps)
│   ├── vultr.sh           # Vultr REST API wrapper
│   ├── sops-enroll.sh     # SSH→age key enrollment
│   └── clevis-bind.sh     # Clevis JWE creation
├── installer/             # iPXE netboot image
│   └── installer.nix
└── legacy/                # Old Pulumi/provision.sh (reference only)
```

## Credentials & Access

- **Vultr API key**: `/run/secrets/ada/vultr-api-key` on signi
  - Set `VULTR_API_KEY_FILE` or `VULTR_API_KEY` before using helpers
- **SSH**: ada's ed25519 key is on the vultr account and so it authenticates to all seed machines
  - `ssh seed-atl-1`, `ssh seed-stake`, etc. (configured in ~/.ssh/config)
- **sops**: ada's age key at `~/.config/sops/age/keys.txt`
  - Josh's PGP key is the other recipient for all secrets
- **S3 cache**: credentials in sops template, deployed via seed-cache.nix profile

## Helper Scripts

Available as flake apps (deterministic dependencies via nix):

```bash
# Vultr operations
nix run .#vultr -- create-vpc atl 10.0.0.0
nix run .#vultr -- create-vm seed-stake vc2-4c-8gb atl <vpc-id>
nix run .#vultr -- list vms
nix run .#vultr -- destroy vm <id>

# Secret enrollment
nix run .#sops-enroll -- seed-atl-1 /tmp/ssh_host_ed25519_key.pub

# Clevis binding
nix run .#clevis-bind -- http://10.0.0.1:7654 /tmp/passphrase
```

Or use them directly — the agent has curl, jq, sops, age, ssh-to-age,
clevis, etc. available in its environment.

## Build Strategy

There is a binary cache, it is critical that this be configured on
each host before nix operations (even after nixos-anywhere kexec phase),
otherwise much duplicate work and wasted time ensues.

Stake is your hands on site. Use it like an ssh bastion and as a
build host, it has a beefy build and high-bandwith connectivity to
the binary cache.

For hosts like puncher, use stake for building, for hosts like the
baremetal do the build "remote" on that host, from stake.

Once stake is deployed you should basically never run a build operation
on the host you're running on (signi), even derivations. Often we're
running on a metered and slow connection, this is the purpose of stake.

```bash
ssh ada@<stake> 'sudo nix build "github:loomtex/seed?dir=infra#nixosConfigurations.seed-puncher-1.config.system.build.toplevel"'
# S3 cache now has all paths. Running a build-on remote pulls from cache
```

The stake has S3 binary cache configured by the provisioning helper:
injected into the stake's nix-daemon environment from signi.
No sops on the stake.

### Stake Provisioning (Ephemeral Kexec)

The stake uses **ephemeral infect**: kexec into NixOS installer, swap
nix store overlay to disk, build the system derivations and closure
ON the stake (so signi doesn't have to upload it), and activate in place.

This is kind of a unique nixos-anywhere flow with no disko, no nixos-install,
and no reboot.

```bash
nix run .#provision-stake              # Full: create VM + provision
nix run .#provision-stake -- --ip <ip> # Provision existing Debian VM
```

The helper handles: VM creation → kexec → S3 cache setup → overlay swap
→ build on target → in-place activation → credential injection → verify.

The stake config has **no bootloader and no disk layout** — it's designed
to run activated on top of the kexec installer. If the VM reboots, it
goes back to Debian and must be re-provisioned (it's ephemeral).

S3 credentials are injected directly by the provisioning agent (not sops),
since the stake has no enrolled host key.

### Node Provisioning (Disko + Install)

For permanent machines (puncher, k8s nodes), use disko + install:

1. **Kexec only**: `nixos-anywhere --phases kexec --build-on remote --flake .#<host> root@<ip>`
2. **Set up S3 cache** in kexec env (credentials + nix.conf substituter)
3. **Swap nix store overlay to disk** (if tmpfs is too small)
4. **Disko**: `nixos-anywhere --phases disko --build-on remote --flake .#<host> root@<ip>`
5. **Build on target**: `nix build "github:loomtex/seed?dir=infra#nixosConfigurations.<host>.config.system.build.toplevel"`
6. **Install**: `nixos-install --root /mnt --system <toplevel-path> --no-root-passwd`
7. **Reboot**

### Vultr VM SSH Keys

The `vultr.sh` helper auto-includes all registered SSH keys when creating
VMs and bare metals. Without SSH keys, Debian VMs only allow password auth.

## Key Patterns

### nixos-anywhere

Used to install NixOS on Debian VMs and netbooted bare metal:

```bash
nixos-anywhere --flake .#seed-atl-1 --target-host root@<ip> --build-on-remote \
  --disk-encryption-keys /tmp/disk-password /tmp/disk-password \
  --extra-files /tmp/extra-files
```

Most nixos-anywhere provisions are multi-call, the kexec phase is executed, then
the S3 binary cache is configured, then the disko and nixos-install phases are run.

The `--extra-files` directory should contain:
- `/persist/secrets/initrd/ssh_host_ed25519_key` — initrd SSH host key

### iPXE Netboot

Bare metal nodes boot via iPXE from Vultr's Custom OS (159):
1. Vultr boots iPXE with a startup script
2. Script fetches kernel + initrd from stake's nginx (:8080)
3. Node boots into NixOS installer(nixos-anywhere kexec env) with SSH enabled
4. Phone-home service POSTs to stake's registration endpoint (:8081)
5. Agent detects registration and begins provisioning

### LUKS + Clevis Flow

1. nixos-anywhere installs with LUKS passphrase
3. Create Clevis JWE: `echo -n <pass> | clevis encrypt tang '{"url":"..."}'`
4. Copy JWE to `/boot/secrets/clevis-cryptroot.jwe`
5. Clevis auto-unlocks via Tang over VPC after reboot

### Ceph Secret Generation

Ceph auth keys must be generated once per cluster before building node closures.
All Ceph daemon bootstrap (MON, MGR, OSD) is automated by `profiles/seed-ceph.nix` —
only the secrets require manual generation.

```bash
# Generate ceph auth keys (MUST use ceph-authtool, not raw random)
nix-shell -p ceph --run 'ceph-authtool --gen-print-key'  # mon key
nix-shell -p ceph --run 'ceph-authtool --gen-print-key'  # admin key

# Add to sops
sops --set '["ceph"] {"mon-key": "<mon-key>", "admin-key": "<admin-key>"}' \
  secrets/seed-system.yaml
```

The fsid is in `cluster.nix` (`ceph.fsid`). Per-node OSD config (osdId, osdDevice)
is also in `cluster.nix` and passed to the profile via `specialArgs`.

### k3s Cluster Join

- Init node: `seed.k3s.clusterInit = true` (starts embedded etcd)
- Other nodes: `seed.serverAddr` or `/persist/seed/server-addr` points to init node
- All nodes need the same k3s token (from sops secrets)

## Cluster Topology

See cluster.nix for the actual definitions, but most clusters contain
a puncher for network management services (tang, dns, etc), and k3s
nodes configured to run the seed workloads.

Stake is ephemeral and only runs for provision operations.

Example:

| Machine | Type | Plan | VPC IP | Role |
|---------|------|------|--------|------|
| seed-stake | VM | vx1-g-4c-16g-240s | 10.0.0.2 | Provisioner (ephemeral, kexec) |
| seed-puncher-1 | VM | vc2-1c-2gb | 10.0.0.1 | Tang + DNS |
| seed-atl-1 | BM | vbm-6c-32gb | 10.0.0.10 | k3s init + controller |
| seed-atl-2 | BM | vbm-6c-32gb | 10.0.0.11 | k3s server |
| seed-atl-3 | BM | vbm-6c-32gb | 10.0.0.12 | k3s server |

## Orchestration Model

Provisioning is orchestrated from **signi** (the workstation), through the
stake. The agent runs locally and uses SSH to reach remote machines. This
approach is simpler and more resilient:

- **Parallel provisioning** — spin up parallel agents on signi that each SSH
  to different nodes through the stake for concurrent provisioning
- **Resilient** — if the stake has issues, the orchestration context survives

The stake's role is for handling builds in the DC and for hosting some
provision specific services: nginx for iPXE netboot (:8080) and the
registration endpoint for phone-home (:8081).

## What NOT to do

- Don't use Pulumi (code in `legacy/` is for reference only)
- Don't hardcode things — expand vars, reference variables, read from `cluster.nix` and `data/vpc.nix`
- For the ephemeral infect, you can't hot-add VPC networks so they must be added at build time
- Don't skip Clevis binding — every LUKS node needs Tang auto-unlock
