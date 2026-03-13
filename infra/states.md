# Seed Infrastructure State Model

This document defines the lifecycle states for seed infrastructure resources.
It is the agent's primary reference for understanding what exists, what should
exist, and how to get from here to there.

## Living Document

**This is a living document.** The provisioning agent should actively improve it
while working. When you encounter:

- A state transition that needs an intermediate step → split it
- Detection logic that doesn't work in practice → fix the detection rule
- A transition whose prerequisites are incomplete → add the missing guards
- Steps that are misleadingly worded → reword them
- States that should be combined → merge them

After each provisioning run, review what went well and what was confusing.
Propose edits back — the goal is to make deterministic infrastructure
management as easy as possible for any agent reading this document.

## State File

Runtime state is tracked in `.state/atl.md` (checked into git).
The agent writes Vultr IDs, IPs, current states, and notes there, then
commits the update alongside any infrastructure changes. This gives:
- **Human readability**: Josh can glance at it to see cluster status
- **Git history**: Natural audit trail of infrastructure changes
- **Agent startup**: Reads current state without probing everything from scratch

If the state file is stale or missing, probe Vultr API + SSH to reconstruct.

## Resource States

### VPC

| State | Detection |
|-------|-----------|
| `absent` | No VPC ID in state file, or Vultr API returns 404 |
| `active` | Vultr API returns VPC with matching subnet |

**Transitions:**
```
absent → active
  needs: Vultr API key, region + subnet from cluster.nix
  action: Create VPC via Vultr API
  after: VPC ID recorded in state file
  notes: Create BEFORE stake — stake must be born with VPC NIC
```

### Stake

| State | Detection |
|-------|-----------|
| `absent` | No Vultr instance with this label/ID |
| `created` | Instance exists, may not have IP yet |
| `ssh-ready` | SSH to root@IP succeeds (Debian default OS) |
| `nixos-active` | SSH as ada succeeds, `hostname` returns `seed-stake` |
| `ready` | Netboot HTTP serving on :8080, registration endpoint on :8081 |

**Transitions:**
```
absent → created
  needs: VPC active
  action: Create VM via Vultr API with VPC attached at creation
          MUST include sshkey_id for SSH key auth (Debian root uses password-only otherwise)
  notes: VPC NIC must be present at creation (not hot-added)
         OS: Debian 12 (os_id 2136) — nixos-anywhere replaces it
         SSH key IDs: e3845d1c (ada@signi), 75e78e5b (josh@6bit.com)

created → ssh-ready
  needs: VM has public IP assigned
  action: Poll SSH on root@<ip> until connection succeeds (key auth, not password)
  notes: Takes 2-5 minutes. Use -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
         for first connection

ssh-ready → nixos-active
  needs: SSH access as root
  action: nixos-anywhere --flake .#seed-stake --target-host root@<ip> --build-on-remote
  notes: ALWAYS use --build-on-remote. NEVER build on signi (Starlink upstream is slow).
         The target pulls from cache.nixos.org directly with datacenter bandwidth.
         nixos-anywhere handles: kexec → disko → build → install → reboot.
         After reboot, SSH as ada (not root) on port 22.

nixos-active → ready
  needs: SSH as ada, seed-cache profile active
  action: Verify nginx :8080 and registration :8081 responding
  notes: Services start automatically from NixOS config.
         S3 binary cache is available after sops secrets are enrolled.
```

### Puncher (seed-puncher-1)

| State | Detection |
|-------|-----------|
| `absent` | No Vultr instance with this label/ID |
| `created` | Instance exists |
| `ssh-ready` | SSH to root@IP succeeds (Debian) |
| `nixos-installed` | SSH as ada, hostname = `seed-puncher-1` |
| `tang-ready` | `curl http://<vpcIp>:<tangPort>/adv` returns JSON |

**Transitions:**
```
absent → created
  needs: VPC active
  action: Create VM with VPC attached at creation
  notes: Created with VPC so Tang is reachable over VPC immediately

created → ssh-ready
  action: Poll SSH on root@<ip>

ssh-ready → nixos-installed
  needs: SSH as root
  action: nixos-anywhere --flake .#seed-puncher-1 --target-host root@<ip> --build-on-remote
  notes: ALWAYS --build-on-remote. Target pulls from cache.nixos.org + S3 binary cache.
         If stake is already provisioned and has S3 cache, pre-build on stake first:
           ssh root@<stake> 'nix build github:loomtex/seed/infra#nixosConfigurations.seed-puncher-1.config.system.build.toplevel'
         This populates S3 cache, then puncher pulls from S3 instead of rebuilding.

nixos-installed → tang-ready
  needs: VPC interface configured (seed-vpc service)
  action: Verify Tang advertisement: curl http://<vpcIp>:7654/adv
  notes: Tang keys auto-generated on first boot by tangd-keygen service
         Back up /var/lib/private/tang/ — losing keys = re-enroll all nodes
```

### Node (bare metal)

| State | Detection |
|-------|-----------|
| `absent` | No Vultr BM with this label/ID |
| `created` | BM exists, iPXE booting |
| `phone-homed` | Registration file exists on stake: /var/lib/seed-register/<mac>.json |
| `keys-enrolled` | Node hostname in .sops.yaml, secrets/<hostname>.yaml exists |
| `nixos-installed` | nixos-anywhere completed (node rebooting into LUKS) |
| `luks-locked` | SSH responds on port 2222 (initrd), not port 22 |
| `running` | SSH on port 22, hostname matches, /dev/mapper/cryptroot exists |
| `k3s-joined` | `kubectl get node <name>` shows Ready |
| `healthy` | All expected pods running, no unresolvable taints |

**Transitions:**
```
absent → created
  needs: Stake ready (serving netboot), iPXE boot script on Vultr
  action: Create BM via Vultr API with OS 159 (Custom/iPXE) + boot script
  notes: Boot script points to stake's netboot HTTP endpoint
         BM iPXE netboot is BIOS-only on Vultr

created → phone-homed
  needs: BM boots into installer, gets DHCP, runs phone-home service
  action: Wait for registration file on stake
  notes: Phone-home URL is in iPXE boot script kernel cmdline
         May take 5-15 minutes (BIOS POST + PXE + boot)

phone-homed → keys-enrolled
  needs: SSH access to node (installer env, root)
  action:
    1. SSH to node, extract /etc/ssh/ssh_host_ed25519_key.pub
    2. ssh-to-age to convert to age recipient
    3. Add to .sops.yaml (anchor + creation rule + seed-system rule)
    4. Create secrets/<hostname>.yaml with k3s-token
    5. Commit and push
  notes: The sops-enroll helper prints the .sops.yaml additions needed
         k3s-token must match the init node's token

keys-enrolled → nixos-installed
  needs: Node SSH (installer), secrets committed, puncher tang-ready
  action:
    1. Generate LUKS passphrase, write to /tmp/disk-password
    2. Generate initrd SSH host key
    3. Pre-build on stake: ssh root@<stake> 'nix build github:loomtex/seed/infra#nixosConfigurations.<hostname>.config.system.build.toplevel'
    4. nixos-anywhere --flake .#<hostname> --target-host root@<ip> --build-on-remote --disk-encryption-keys /tmp/disk-password /tmp/disk-password --extra-files <dir>
  notes: ALWAYS --build-on-remote. Pre-build on stake populates S3 cache, so the
         target pulls from S3 instead of rebuilding (minutes vs hours).
         extra-files must include /persist/secrets/initrd/ssh_host_ed25519_key
         Node reboots into LUKS-encrypted NixOS

nixos-installed → luks-locked
  needs: Node rebooted after nixos-anywhere
  action: Wait for SSH on port 2222 (initrd)
  notes: First boot — no Clevis JWE yet, so Tang auto-unlock won't work
         initrd SSH gives a shell for manual passphrase entry

luks-locked → running
  needs: LUKS passphrase (from provisioning) OR Clevis JWE
  action:
    First boot: SSH to port 2222, enter passphrase via systemd-tty-ask-password-agent
    Then: Create Clevis JWE, copy to /persist/secrets/clevis-cryptroot.jwe
    Future boots: Clevis auto-unlocks via Tang
  notes: After first manual unlock, create JWE:
         echo -n <passphrase> | clevis encrypt tang '{"url":"http://10.0.0.1:7654"}' > /tmp/jwe
         scp /tmp/jwe <node>:/persist/secrets/clevis-cryptroot.jwe
         The disks.nix already has clevis.enable = true

running → k3s-joined
  needs: clusterInit node must be running first (provides k3s token + API)
  action: k3s starts automatically, joins cluster via serverAddr
  notes: serverAddr is written to /persist/seed/server-addr by provisioner
         for non-init nodes. Init node uses clusterInit = true.
         VPC connectivity required for etcd peering.

k3s-joined → healthy
  needs: All seed-system pods scheduled and running
  action: Verify via kubectl:
    - seed-controller pod running (on controller nodes)
    - seed-host-agent pod running (DaemonSet, all nodes)
    - seed-pool-manager pod running (on controller nodes)
    - MetalLB speaker running (DaemonSet, all nodes)
  notes: May take a few minutes for all pods to schedule and pull images
```

## Dependency Order

```
VPC ─→ Stake(+VPC) ─→ Puncher ─→ Node(clusterInit=true) ─→ Node(others)
                                                            ↗
                                                 (parallel)
```

VPC is created first so stake is born with its VPC NIC.
Puncher needs to be tang-ready before nodes can be installed (Clevis binding).
The clusterInit node must be running before others can join.
Non-init nodes can be provisioned in parallel.

## Tools Available

The agent has these tools for infrastructure operations:

- **Vultr API**: `VULTR_API_KEY_FILE` at `/run/secrets/ada/vultr-api-key` (on signi)
  - Or via helper: `nix run .#vultr -- <command>`
- **SSH**: Agent has ed25519 key, targets authorize ada@signi
- **nixos-anywhere**: Remote NixOS installation over SSH
- **sops/age**: Secret encryption/decryption
- **ssh-to-age**: SSH pubkey → age recipient conversion
- **clevis/jose**: LUKS Tang binding
- **kubectl**: Kubernetes cluster management (via k3s kubeconfig)

## Recovery

If the state file is lost, reconstruct by:
1. `nix run .#vultr -- list vms` and `list bms` to find resources
2. SSH to each to determine its state
3. Write findings to `.state/atl.md`

If a node is stuck in a bad state, the safest recovery is usually:
1. Destroy the Vultr resource
2. Remove from state file
3. Re-provision from `absent`
