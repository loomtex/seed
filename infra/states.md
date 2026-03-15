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

Runtime state is tracked in `.state/atl1.md` (checked into git).
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

### Reserved IPs

| State | Detection |
|-------|-----------|
| `absent` | No reserved IPs for this region in Vultr API |
| `allocated` | IPs exist in Vultr API, recorded in state file |
| `attached` | IPv4 attached to a BM in the cluster |

**Transitions:**
```
absent → allocated
  needs: Region from cluster.nix
  action:
    1. Reserve IPv4: nix run .#vultr -- reserve-ipv4 <region>
    2. Reserve IPv6 /64: nix run .#vultr -- reserve-ipv6 <region>
    3. Record IPs in state file
    4. Update source files with allocated IPs:
       - instances/dns.nix: NS/A/AAAA glue records
       - flake.nix: seed.ipv6.block
       - infra/machines/atl/seed-atl1-1/configuration.nix: controller.ipv4Address, controller.ipv6Block
    5. Commit and push (IPs must be in configs BEFORE node builds)
  notes: Reserve IPs BEFORE building any node closures — the controller
         config references these IPs, and DNS zone records include them.
         The IPv6 block from Vultr is a /64 — record the full CIDR.

allocated → attached
  needs: At least one node running
  action: Attach IPv4 to a BM via Vultr API (any node — MetalLB L2 manages announcement)
  notes: IPv6 /64 doesn't need explicit attachment — MetalLB announces via NDP.
         The attached instance is just the "anchor" — MetalLB can ARP-respond
         from any node with a speaker pod.
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
| `ready` | SSH as ada, hostname=stake, nginx :8080 + registration :8081 up |

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
       nixos-anywhere --phases kexec --build-on remote --flake .#stake root@<ip>
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
    5. Build stake closure ON the stake:
       nix build "github:loomtex/seed?dir=infra#...stake...toplevel"
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

### Puncher (puncher-atl1-1)

| State | Detection |
|-------|-----------|
| `absent` | No Vultr instance with this label/ID |
| `created` | Instance exists |
| `ssh-ready` | SSH to root@IP succeeds (Debian) |
| `nixos-installed` | SSH as ada, hostname = `puncher-atl1-1` |
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
      --flake 'github:loomtex/seed?dir=infra#puncher-atl1-1' \
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
         IMPORTANT: Vultr BMs only PXE boot ONCE after provisioning.
         A normal reboot boots from disk, not PXE. To force PXE boot
         again, use the Vultr "reinstall" API with the iPXE script:
           vultr.sh reinstall-bm <id> 159 <script-id>

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
       IMPORTANT: use nested YAML structure:
         seed:
             k3s-token: "<token>"
       NOT flat key: seed/k3s-token: "<token>"
       sops-install-secrets expects nested path (seed.k3s-token).
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

    Phase 2: Configure S3 binary cache + swap overlay to disk
      SSH to root@<ip>, then:
      a. Swap nix store overlay from tmpfs to disk:
         Use the Ceph OSD disk (ata-4) for the overlay, NOT the OS disk (ata-5).
         Disko formats ata-5 — using ata-4 avoids destroying the nix store during disko.
         Device names (sda/sdb) are non-deterministic; use by-path to identify:
           ls -la /dev/disk/by-path/ | grep ata   # find ata-4 → /dev/sdX
         Then:
           OVERLAY_DISK=/dev/disk/by-path/pci-0000:00:17.0-ata-4  # Ceph OSD disk
           mkfs.ext4 -F $OVERLAY_DISK
           mkdir -p /mnt/disk
           mount $OVERLAY_DISK /mnt/disk
           mkdir -p /mnt/disk/upper /mnt/disk/work
           systemctl stop nix-daemon.socket nix-daemon.service
           mount -t overlay overlay \
             -o 'lowerdir=/nix/.ro-store,upperdir=/mnt/disk/upper,workdir=/mnt/disk/work' \
             /nix/store
           systemctl start nix-daemon.socket

         IMPORTANT: Use `/nix/.ro-store` as the lower dir, NOT the path shown
         in `mount` output (`/mnt-root/nix/.ro-store`). The `/mnt-root/...`
         paths are stale after pivot_root — the kernel overlay driver cached
         those inodes internally, but they're no longer resolvable for new
         mounts. `/nix/.ro-store` is the accessible squashfs mount.

         The kexec overlay's tmpfs upper (`/nix/.rw-store/store`) has minimal
         content in a fresh kexec environment — no need to copy it. The new
         overlay stacks on top with the disk-backed upper. nix-daemon (restarted
         after mount) uses the topmost mount for all operations.

         Do NOT use `umount -l /nix/store` — lazy unmount creates a detached
         mount that persists. Just mount the new overlay on top; the stacking
         is harmless since nix-daemon only uses the topmost mount.

         This prevents tmpfs overflow (16GB) when building large derivations.
         Ceph bootstrap will reformat ata-4 later — this is a temporary overlay.
      b. Write /root/.aws/credentials:
         [default]
         aws_access_key_id = <from seed-system-atl1.yaml>
         aws_secret_access_key = <from seed-system-atl1.yaml>
      c. Write /root/.config/nix/nix.conf:
         experimental-features = nix-command flakes
         extra-substituters = s3://seed-nix-cache?endpoint=atl2.vultrobjects.com&region=us-east-1&profile=default
         extra-trusted-substituters = s3://seed-nix-cache?endpoint=atl2.vultrobjects.com&region=us-east-1&profile=default
         extra-trusted-public-keys = seed-cache-1:HmHh2GMeZTBXufX8RRs30bBNVB75+QfkgFllazC365E=
      d. Inject AWS env vars and restart nix-daemon:
         systemctl set-environment \
           AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials \
           AWS_EC2_METADATA_DISABLED=true
         systemctl start nix-daemon.socket
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
      e. Create Clevis JWE (Tang must be reachable over VPC from node):
         Get Tang thumbprint: ssh root@<ip> 'jose jwk thp -i <(curl -sfS http://10.0.0.1:7654/adv | jq ".payload" -r | base64 -d | jq ".keys[0]")'
         Create JWE: ssh root@<ip> 'echo -n <passphrase> | clevis encrypt tang '"'"'{"url":"http://10.0.0.1:7654","thp":"<thumbprint>"}'"'"' > /mnt/boot/secrets/clevis-cryptroot.jwe'
         (mkdir -p /mnt/boot/secrets first; set chmod 600)
      f. Copy extra-files into /mnt:
         scp -r /tmp/<hostname>-extra/* root@<ip>:/mnt/
      g. Install:
         ssh root@<ip> 'nixos-install --root /mnt --system <toplevel-path> --no-root-passwd'
      h. Reboot (or kexec into installed kernel if iPXE reboot loops)

  notes: ALWAYS inject S3 cache BEFORE building on the BM.
         Without S3 cache, kata-guest-kernel + kata-runtime compile from
         source (~20 minutes). With S3 cache, the build pulls pre-built
         paths and finishes in ~2 minutes.
         Phase 3 (pre-build on stake) can be skipped if the closure is
         already in S3 from a previous node's build.
         NEVER build on signi (Starlink upstream too slow).
         extra-files must include /persist/secrets/initrd/ssh_host_ed25519_key
         Create JWE BEFORE nixos-install so it gets embedded in initrd.
         Order: disko → create JWE on /mnt/boot → copy extra-files → nixos-install
         Node reboots into LUKS-encrypted NixOS with Clevis auto-unlock.

nixos-installed → luks-locked
  needs: Node rebooted after nixos-anywhere
  action: Wait for SSH on port 2222 (initrd)
  notes: If Clevis JWE was created and placed on /boot before install,
         auto-unlock should work. If not, SSH to port 2222 for manual unlock.
         initrd SSH gives a shell for manual passphrase entry.

luks-locked → running
  needs: LUKS passphrase (manual) OR Clevis JWE on /boot (auto)
  action:
    Auto: Clevis decrypts JWE via Tang, unlocks LUKS automatically
    Manual fallback: SSH to port 2222, enter passphrase via systemd-tty-ask-password-agent
  notes: JWE lives at /boot/secrets/clevis-cryptroot.jwe (unencrypted ESP).
         append-initrd-secrets embeds it into the initrd at switch/install time.
         The JWE is Tang-encrypted — useless without VPC access to Tang.
         If JWE was not created during provisioning, create it after manual unlock:
         echo -n <passphrase> | clevis encrypt tang '{"url":"http://10.0.0.1:7654","thp":"<thumbprint>"}' \
           | sudo tee /boot/secrets/clevis-cryptroot.jwe > /dev/null
         sudo chmod 600 /boot/secrets/clevis-cryptroot.jwe
         sudo nixos-rebuild boot --flake "github:loomtex/seed?dir=infra#<hostname>" --refresh

running → k3s-joined
  needs: clusterInit node must be running first (provides k3s token + API)
  action: k3s starts automatically, joins cluster via serverAddr
  notes: serverAddr is written to /persist/seed/server-addr by provisioner
         for non-init nodes. Init node uses clusterInit = true.
         VPC connectivity required for etcd peering.

k3s-joined → healthy
  needs: All seed-system pods scheduled and running, reserved IPs attached
  action: Verify via kubectl + network probes:
    - seed-controller pod running (on controller nodes)
    - seed-host-agent pod running (DaemonSet, all nodes)
    - seed-pool-manager pod running (on controller nodes)
    - MetalLB speaker running (DaemonSet, all nodes)
    - IPAddressPool exists with both IPv4 and IPv6 ranges
    - LoadBalancer services have external IPs (not <pending>)
    - dig @<reserved-ipv4> loom.farm SOA returns valid response
    - dig @<reserved-ipv6>::1 loom.farm SOA returns valid response
  notes: May take a few minutes for all pods to schedule and pull images.
         LoadBalancer services won't get IPs until MetalLB is configured
         AND the reserved IPv4 is attached to a node in the cluster.
         IPv6 /64 doesn't need attachment — MetalLB announces via NDP.
```

### Ceph Secrets

Ceph auth keys must be generated once per cluster before nodes are built.
The keys live in `secrets/seed-system-atl1.yaml` (accessible to all nodes) and
the fsid lives in `cluster.nix`. All Ceph daemon bootstrap (MON, MGR, OSD)
is automated by oneshot services in `profiles/seed-ceph.nix` — this section
covers only the one-time secret generation.

| State | Detection |
|-------|-----------|
| `absent` | `sops -d secrets/seed-system-atl1.yaml` has no `ceph` key |
| `generated` | `sops -d secrets/seed-system-atl1.yaml` contains `ceph.mon-key` and `ceph.admin-key` |

**Transitions:**
```
absent → generated
  needs: sops age key on signi, ceph package (via nix-shell)
  action:
    1. Generate fsid (if not already in cluster.nix):
       nix-shell -p util-linux --run 'uuidgen'
       Add to cluster.nix: ceph.fsid = "<uuid>";
    2. Generate ceph auth keys:
       nix-shell -p ceph --run 'ceph-authtool --gen-print-key'  (run twice: mon + admin)
    3. Add to sops secrets:
       sops --set '["ceph"] {"mon-key": "<mon-key>", "admin-key": "<admin-key>"}' \
         secrets/seed-system-atl1.yaml
    4. Verify: sops -d secrets/seed-system-atl1.yaml | grep -A2 ceph
    5. Commit and push (keys must be in secrets BEFORE node builds)
  notes: Keys are base64-encoded with ceph's internal format (type + timestamp
         + length + random bytes). MUST use ceph-authtool, not raw random.
         NEVER use /dev/urandom via bash — use nix-shell for ceph.
         The fsid identifies the cluster — all nodes must share the same one.
         OSD disk devices are specified per-node in cluster.nix (ceph.osdDevice).
```

## Dependency Order

```
VPC ─→ Reserved IPs ──→ Stake(+VPC) ─→ Puncher ─→ Node(clusterInit=true) ─→ Node(others)
              │                                              ↗
              ├─→ Ceph Secrets ─────────────────────────────┘
              │                                    (parallel)
```

VPC is created first so stake is born with its VPC NIC.
Reserved IPs go after VPC because the allocated addresses must be committed
to source files before node closures are built (controller config + DNS records).
Ceph secrets must be generated before node closures are built (nodes reference
`ceph/mon-key` and `ceph/admin-key` from sops). Can be done in parallel with
stake/puncher provisioning.
Puncher needs to be tang-ready before nodes can be installed (Clevis binding).
The clusterInit node must be running before others can join.
Non-init nodes can be provisioned in parallel.
After the first node is healthy, attach the reserved IPv4 to it.

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
3. Write findings to `.state/atl1.md`

If a node is stuck in a bad state, the safest recovery is usually:
1. Destroy the Vultr resource
2. Remove from state file
3. Re-provision from `absent`
