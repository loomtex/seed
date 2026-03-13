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

The stake is **ephemeral kexec-only** — no disk install, no bootloader.
It runs NixOS activated in-place on the kexec installer. If the VM
reboots, it goes back to Debian and must be re-provisioned.

The `provision-stake` helper automates the full flow.

| State | Detection |
|-------|-----------|
| `absent` | No Vultr instance with this label/ID |
| `created` | Instance exists, may not have IP yet |
| `ssh-ready` | SSH to root@IP succeeds (Debian default OS) |
| `ready` | SSH as ada, hostname=seed-stake, nginx :8080 + registration :8081 up |

**Transitions:**
```
absent → created
  needs: VPC active
  action: Create VM via Vultr API with VPC attached at creation.
          vultr.sh auto-includes all registered SSH keys.
  notes: Plan: vx1-g-4c-16g-240s (dedicated AMD, 16GB RAM, 240GB disk)
         OS: Debian 12 (os_id 2136)
         Prefer VPC at creation. Hot-attach works for VMs if needed.

created → ssh-ready
  needs: VM has public IP assigned
  action: Poll SSH on root@<ip> until connection succeeds (key auth)
  notes: Takes 2-5 minutes

ssh-ready → ready
  needs: SSH as root, sops age key on signi (for decrypting S3 credentials)
  action: Run `nix run .#provision-stake -- --ip <ip>` (or just `nix run .#provision-stake`
          to create VM + provision in one shot). The helper does:
    1. Kexec into NixOS installer:
       nixos-anywhere --phases kexec --build-on remote --flake .#seed-stake root@<ip>
    2. Wait for SSH to reconnect (NixOS installer boots)
    3. Configure S3 binary cache in installer:
       - Write /root/.aws/credentials and signing key
       - Write post-build-hook script (sign + upload to S3)
       - Inject AWS env vars into nix-daemon via systemctl set-environment
       - Write /root/.config/nix/nix.conf (extra-substituters, post-build-hook)
    4. Swap nix store overlay from tmpfs to disk:
       - mkfs.ext4 /dev/vda, mount at /mnt/disk
       - Copy existing overlay upper to disk
       - Remount /nix/store with disk-backed upper
    5. Build seed-stake closure ON the stake:
       nix build "github:loomtex/seed?dir=infra#...seed-stake...toplevel"
       (S3 cache provides pre-built derivations — minutes, not hours)
    6. Activate in-place:
       - $TOPLEVEL/activate (users, /etc, tmpfiles)
       - systemctl daemon-reload
       - Fix DNS (resolv.conf → real nameservers, not systemd-resolved)
       - Start services: suid-sgid-wrappers, seed-vpc, nginx, seed-register, sshd
    7. Re-inject S3 credentials (activation replaces /etc/nix/nix.conf)
    8. Verify: hostname, VPC NIC, nginx :8080, registration :8081
  notes: NEVER build on signi (Starlink upstream). Build ON the stake.
         No disko, no nixos-install, no reboot — activated in-place.
         Stake config has no sops secrets — credentials injected directly.
         The kexec config has no bootloader and no disk layout.
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
  needs: SSH as root, stake ready
  action: FROM STAKE (via agent forwarding) — SSH to stake with -A, then run:
    ssh -A ada@<stake>
    sudo SSH_AUTH_SOCK=$SSH_AUTH_SOCK nix run nixpkgs#nixos-anywhere -- \
      --flake 'github:loomtex/seed?dir=infra#seed-puncher-1' \
      --target-host root@<ip> --build-on local
  notes: --build-on local means stake builds (16GB RAM, S3 cache), then
         pushes the closure to the puncher. The puncher only has 2GB RAM
         and CANNOT build — Go compilation (sops-install-secrets) will OOM.
         NEVER run nixos-anywhere from signi (Starlink upstream too slow).
         NEVER use --build-on-remote for the puncher (OOM).
         Agent forwarding (-A) is required because the stake's own SSH key
         is not authorized on newly created Debian VMs — only signi's keys
         are registered with Vultr.

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
         Prefer VPC at creation. Hot-attach works for BMs (verified):
         NIC gets carrier, but only has link-local IP. Must manually
         assign 10.0.0.x/24 for VPC connectivity. Tang reachable.

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
  action: Phased provisioning — kexec first, then S3 cache, then build+install.

    Phase 1: Kexec into NixOS installer
      nixos-anywhere --phases kexec --build-on remote \
        --flake "github:loomtex/seed?dir=infra#<hostname>" root@<ip>
      Wait for SSH to reconnect (installer boots, ~30s).

    Phase 2: Configure S3 binary cache in installer
      SSH to root@<ip>, then:
      a. Write /root/.aws/credentials:
         [default]
         aws_access_key_id = <from seed-system.yaml>
         aws_secret_access_key = <from seed-system.yaml>
      b. Write /root/.config/nix/nix.conf:
         extra-substituters = s3://seed-nix-cache?endpoint=atl2.vultrobjects.com&region=us-east-1&profile=default
         extra-trusted-substituters = s3://seed-nix-cache?endpoint=atl2.vultrobjects.com&region=us-east-1&profile=default
         extra-trusted-public-keys = seed-cache-1:HmHh2GMeZTBXufX8RRs30bBNVB75+QfkgFllazC365E=
      c. Inject AWS env vars into nix-daemon:
         systemctl set-environment \
           AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials \
           AWS_EC2_METADATA_DISABLED=true
         systemctl restart nix-daemon
      This lets the BM pull pre-built derivations from S3 instead of
      compiling kata-guest-kernel and kata-runtime from source (~20min saved).

    Phase 3: Pre-build on stake (populate S3 cache)
      ssh -A ada@<stake>
      sudo nix build --refresh "github:loomtex/seed?dir=infra#nixosConfigurations.<hostname>.config.system.build.toplevel"
      Post-build-hook uploads all paths to S3 automatically.
      This step only needs to be done once per unique closure — after the
      first node is built, subsequent nodes pull from S3.

    Phase 4: Build on target + disko + install
      On signi (or stake via agent forwarding):
      a. Generate LUKS passphrase, write to /tmp/disk-password
      b. Prepare extra-files dir with:
         - /persist/secrets/initrd/ssh_host_ed25519_key{,.pub}
         - /persist/etc/ssh/ssh_host_ed25519_key{,.pub}
         - /persist/etc/ssh/ssh_host_rsa_key{,.pub}
         - /persist/seed/server-addr (for non-init nodes)
      c. Build on the BM (pulls from S3 cache):
         ssh root@<ip> 'nix build --refresh --print-out-paths \
           "github:loomtex/seed?dir=infra#nixosConfigurations.<hostname>.config.system.build.toplevel"'
      d. Run disko:
         nixos-anywhere --phases disko --build-on remote \
           --flake "github:loomtex/seed?dir=infra#<hostname>" root@<ip> \
           --disk-encryption-keys /tmp/disk-password /tmp/disk-password
      e. Create empty Clevis JWE placeholder (disko expects it):
         ssh root@<ip> 'mkdir -p /mnt/persist/secrets && touch /mnt/persist/secrets/clevis-cryptroot.jwe'
      f. Install:
         ssh root@<ip> 'nixos-install --root /mnt --system <toplevel-path> --no-root-passwd'
      g. Copy extra-files into /mnt:
         scp -r /tmp/<hostname>-extra/* root@<ip>:/mnt/
      h. Reboot (or kexec into installed kernel if iPXE reboot loops)

  notes: ALWAYS inject S3 cache BEFORE building on the BM.
         Without S3 cache, kata-guest-kernel + kata-runtime compile from
         source (~20 minutes). With S3 cache, the build pulls pre-built
         paths and finishes in ~2 minutes.
         Phase 3 (pre-build on stake) can be skipped if the closure is
         already in S3 from a previous node's build.
         NEVER build on signi (Starlink upstream too slow).
         extra-files must include /persist/secrets/initrd/ssh_host_ed25519_key
         Node reboots into LUKS-encrypted NixOS.

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
