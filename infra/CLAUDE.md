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
- `.state/atl.md` — Where we are now (runtime state, gitignored)

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
- **SSH**: ada's ed25519 key authenticates to all seed machines
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

## Key Patterns

### nixos-anywhere

Used to install NixOS on Debian VMs and netbooted bare metal:

```bash
nixos-anywhere --flake .#seed-atl-1 \
  --disk-encryption-keys /tmp/disk-password /tmp/disk-password \
  --extra-files /tmp/extra-files \
  root@<ip>
```

The `--extra-files` directory should contain:
- `/persist/secrets/initrd/ssh_host_ed25519_key` — initrd SSH host key

### iPXE Netboot

Bare metal nodes boot via iPXE from Vultr's Custom OS (159):
1. Vultr boots iPXE with a startup script
2. Script fetches kernel + initrd from stake's nginx (:8080)
3. Node boots into NixOS installer with SSH enabled
4. Phone-home service POSTs to stake's registration endpoint (:8081)
5. Agent detects registration and begins provisioning

### LUKS + Clevis Flow

1. nixos-anywhere installs with LUKS passphrase
2. First boot: SSH to port 2222 (initrd), manually enter passphrase
3. Create Clevis JWE: `echo -n <pass> | clevis encrypt tang '{"url":"..."}'`
4. Copy JWE to `/persist/secrets/clevis-cryptroot.jwe`
5. Future boots: Clevis auto-unlocks via Tang over VPC

### k3s Cluster Join

- Init node: `seed.k3s.clusterInit = true` (starts embedded etcd)
- Other nodes: `seed.serverAddr` or `/persist/seed/server-addr` points to init node
- All nodes need the same k3s token (from sops secrets)

## ATL Cluster Topology

From `cluster.nix`:

| Machine | Type | Plan | VPC IP | Role |
|---------|------|------|--------|------|
| seed-stake | VM | vc2-4c-8gb | 10.0.0.2 | Provisioner (ephemeral) |
| seed-puncher-1 | VM | vc2-1c-2gb | 10.0.0.1 | Tang + DNS |
| seed-atl-1 | BM | vbm-6c-32gb | 10.0.0.10 | k3s init + controller |
| seed-atl-2 | BM | vbm-6c-32gb | 10.0.0.11 | k3s server |
| seed-atl-3 | BM | vbm-6c-32gb | 10.0.0.12 | k3s server |

## Observable Provisioning

Josh can watch provisioning by SSHing to the stake and attaching to
the tmux session. The agent should communicate clearly in its output
so a human observer can follow along.

## What NOT to do

- Don't use Pulumi (it's in `legacy/` for reference only)
- Don't build NixOS closures on signi — build on stake or on the target
- Don't hardcode IPs — read from `cluster.nix` and `data/vpc.nix`
- Don't hot-add VPC NICs — create VMs/BMs with VPC attached from the start
- Don't skip Clevis binding — every LUKS node needs Tang auto-unlock
