#!/usr/bin/env bash
#
# provision.sh — Provision seed cluster from signi via ephemeral stake VM
#
# Creates a beefy VM in the same datacenter as the targets, provisions it with
# NixOS (nixos-anywhere), then runs Pulumi ON the stake so all builds and
# transfers happen in-datacenter. Pulumi state lives in S3 (Vultr Object
# Storage) so nothing needs to be copied back. After Pulumi creates resources,
# runs provision-cluster.ts which watches for phone-home registrations and
# provisions machines as they appear.
#
# Usage:
#   ./provision.sh              # Full run: create stake, run Pulumi + provision, destroy
#   ./provision.sh --setup-only     # Stop after setup, print SSH instructions
#   ./provision.sh --skip-destroy   # Keep stake alive for debugging
#   ./provision.sh --destroy-only   # Just destroy an existing stake
#   ./provision.sh --teardown       # Full teardown: detach stake, pulumi destroy, destroy stake
#
# Prerequisites:
#   - Vultr API key at /run/secrets/ada/vultr-api-key (signi sops)
#   - Age key at ~/.config/sops/age/keys.txt
#   - SSH agent with key loaded (forwarded to stake for target access)
#   - mynix repo at $MYNIX_DIR (default: /agents/ada/projects/mynix)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Re-exec inside the infra flake devshell if nixos-anywhere isn't on PATH
if ! command -v nixos-anywhere &>/dev/null; then
  exec nix develop "$SCRIPT_DIR#ci" -c bash "$0" "$@"
fi

SEED_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MYNIX_DIR="${MYNIX_DIR:-/agents/ada/projects/mynix}"
VULTR_API_KEY_FILE="${VULTR_API_KEY_FILE:-/run/secrets/ada/vultr-api-key}"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
STAKE_STATE_FILE="$SCRIPT_DIR/.stake-id"

# Pulumi state in S3 (same bucket as nix binary cache)
PULUMI_S3_BUCKET="seed-nix-cache"
PULUMI_S3_ENDPOINT="atl2.vultrobjects.com"
PULUMI_BACKEND_URL="s3://${PULUMI_S3_BUCKET}?endpoint=${PULUMI_S3_ENDPOINT}&region=us-east-1&s3ForcePathStyle=true"

# Stake VM config
STAKE_REGION="${STAKE_REGION:-atl}"
STAKE_PLAN="${STAKE_PLAN:-vc2-4c-8gb}"
STAKE_LABEL="seed-stake"
STAKE_FLAKE="github:joshperry/mynix#seed-stake"
STAKE_KEXEC_FLAKE="github:joshperry/mynix#seed-stake-kexec"
STAKE_OS_ID=2136  # Debian 12

# S3 binary cache (same bucket as Pulumi state)
S3_CACHE_SUBSTITUTER="s3://seed-nix-cache?endpoint=atl2.vultrobjects.com&region=us-east-1&profile=default"
S3_CACHE_PUBKEY="seed-cache-1:HmHh2GMeZTBXufX8RRs30bBNVB75+QfkgFllazC365E="

# --- Helpers ---

log() { echo "==> $*" >&2; }
err() { echo "ERROR: $*" >&2; exit 1; }

# vultr-cli wrapper — uses VULTR_API_KEY env var automatically
vultr() { vultr-cli "$@"; }

ssh_opts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

remote_ssh() {
  local user="$1" ip="$2"
  shift 2
  ssh -A "${ssh_opts[@]}" "$user@$ip" "$@"
}

remote_scp() {
  scp "${ssh_opts[@]}" "$@"
}

# --- Pre-flight checks ---

preflight() {
  [[ -f "$VULTR_API_KEY_FILE" ]] || err "Vultr API key not found: $VULTR_API_KEY_FILE"
  VULTR_API_KEY="$(cat "$VULTR_API_KEY_FILE")"
  export VULTR_API_KEY

  [[ -f "$AGE_KEY_FILE" ]] || err "Age key not found: $AGE_KEY_FILE"
  [[ -d "$MYNIX_DIR" ]] || err "mynix dir not found: $MYNIX_DIR"
  ssh-add -l &>/dev/null || err "No SSH agent keys loaded (needed for agent forwarding)"

  command -v nixos-anywhere >/dev/null || err "nixos-anywhere not in PATH"
  command -v sops >/dev/null || err "sops not in PATH"
  command -v jq >/dev/null || err "jq not in PATH"
  command -v vultr-cli >/dev/null || err "vultr-cli not in PATH"

  # Decrypt Pulumi passphrase (needed for stake to run Pulumi)
  PULUMI_PASSPHRASE="$(sops --decrypt --extract '["pulumi-passphrase"]' "$MYNIX_DIR/secrets/pulumi-passphrase.yaml")"
  export PULUMI_PASSPHRASE

  # Decrypt S3 credentials for Pulumi state backend (same bucket as nix binary cache)
  S3_ACCESS_KEY="$(sops --decrypt --extract '["seed"]["s3-access-key"]' "$MYNIX_DIR/secrets/seed-system.yaml")"
  S3_SECRET_KEY="$(sops --decrypt --extract '["seed"]["s3-secret-key"]' "$MYNIX_DIR/secrets/seed-system.yaml")"
  export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
  export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"

  # Decrypt cache signing key (for pushing built derivations to S3)
  S3_SIGNING_KEY="$(sops --decrypt --extract '["seed"]["cache-signing-key"]' "$MYNIX_DIR/secrets/seed-system.yaml")"
}

# --- Stake VM lifecycle ---

ensure_ssh_keys() {
  # Stake is created before Pulumi, so SSH keys might not exist in Vultr yet.
  # Upload keys from ssh-agent if they're not already registered.
  local existing_fps
  existing_fps="$(vultr ssh-key list -o json | jq -r '.ssh_keys[].ssh_key' | ssh-keygen -l -f - 2>/dev/null | awk '{print $2}' || true)"

  local i=0
  while IFS= read -r pubkey; do
    local fp
    fp="$(echo "$pubkey" | ssh-keygen -l -f - 2>/dev/null | awk '{print $2}')"
    if echo "$existing_fps" | grep -qF "$fp" 2>/dev/null; then
      continue
    fi
    local comment
    comment="$(echo "$pubkey" | awk '{print $3}')"
    [[ -z "$comment" ]] && comment="key-$i"
    log "Uploading SSH key: $comment"
    vultr ssh-key create --name "$comment" --key "$pubkey" > /dev/null
    i=$((i + 1))
  done < <(ssh-add -L 2>/dev/null)
}

create_stake() {
  if [[ -f "$STAKE_STATE_FILE" ]]; then
    local existing_id
    existing_id="$(cat "$STAKE_STATE_FILE")"
    log "Stake VM already exists: $existing_id"

    # Verify it's still alive
    local status
    status="$(vultr instance get "$existing_id" -o json 2>/dev/null | jq -r '.instance.status' 2>/dev/null || echo "gone")"
    if [[ "$status" != "gone" ]]; then
      STAKE_ID="$existing_id"
      local instance_json
      instance_json="$(vultr instance get "$existing_id" -o json)"
      STAKE_IP="$(echo "$instance_json" | jq -r '.instance.main_ip')"
      STAKE_VPC_IP="$(echo "$instance_json" | jq -r '.instance.internal_ip')"
      log "Reusing existing stake at $STAKE_IP (VPC IP: $STAKE_VPC_IP, status: $status)"
      return 0
    else
      log "Stale state file — VM is gone, creating new one"
      rm -f "$STAKE_STATE_FILE"
    fi
  fi

  log "Creating stake VM ($STAKE_PLAN in $STAKE_REGION)"

  # Ensure SSH keys are in Vultr (stake is created before Pulumi)
  ensure_ssh_keys

  # Find SSH key IDs
  local ssh_key_args=()
  while IFS= read -r key_id; do
    [[ -n "$key_id" ]] && ssh_key_args+=(--ssh-keys "$key_id")
  done < <(vultr ssh-key list -o json | jq -r '.ssh_keys[].id')

  # Create instance (no VPC yet — Pulumi creates VPC, then we attach)
  local output
  output="$(vultr instance create \
    --region "$STAKE_REGION" \
    --plan "$STAKE_PLAN" \
    --os "$STAKE_OS_ID" \
    --label "$STAKE_LABEL" \
    --host "$STAKE_LABEL" \
    --ipv6 \
    "${ssh_key_args[@]}" \
    -o json)"

  STAKE_ID="$(echo "$output" | jq -r '.instance.id')"
  echo "$STAKE_ID" > "$STAKE_STATE_FILE"
  log "Created stake VM: $STAKE_ID"

  # Wait for public IP assignment (used for SSH from signi)
  log "Waiting for IP assignment..."
  local attempts=0
  while (( attempts < 60 )); do
    STAKE_IP="$(vultr instance get "$STAKE_ID" -o json | jq -r '.instance.main_ip')"
    if [[ "$STAKE_IP" != "0.0.0.0" && "$STAKE_IP" != "null" && -n "$STAKE_IP" ]]; then
      break
    fi
    sleep 5
    attempts=$(( attempts + 1 ))
  done
  [[ "$STAKE_IP" != "0.0.0.0" ]] || err "Stake IP not assigned after 5 minutes"
  log "Stake public IP: $STAKE_IP"
}

# Attach stake to Pulumi's VPC and get its VPC IP.
# Called between the two Pulumi phases.
attach_stake_to_vpc() {
  local vpc_id="$1"

  # Check if already attached
  local current_internal
  current_internal="$(vultr instance get "$STAKE_ID" -o json | jq -r '.instance.internal_ip')"
  if [[ -n "$current_internal" && "$current_internal" != "null" && "$current_internal" != "" ]]; then
    STAKE_VPC_IP="$current_internal"
    log "Stake already on VPC (IP: $STAKE_VPC_IP)"
    return 0
  fi

  log "Attaching stake to VPC $vpc_id..."
  curl -sf -X POST "https://api.vultr.com/v2/instances/$STAKE_ID/vpcs/attach" \
    -H "Authorization: Bearer $VULTR_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"vpc_id\":\"$vpc_id\"}"

  # Wait for Vultr to assign VPC IP (API-side, not yet on the instance's OS)
  log "Waiting for VPC IP assignment..."
  local attempts=0
  while (( attempts < 30 )); do
    STAKE_VPC_IP="$(vultr instance get "$STAKE_ID" -o json | jq -r '.instance.internal_ip')"
    if [[ -n "$STAKE_VPC_IP" && "$STAKE_VPC_IP" != "null" && "$STAKE_VPC_IP" != "" ]]; then
      break
    fi
    sleep 5
    attempts=$(( attempts + 1 ))
  done
  [[ -n "$STAKE_VPC_IP" && "$STAKE_VPC_IP" != "null" ]] || err "Stake VPC IP not assigned"
  log "Stake VPC IP: $STAKE_VPC_IP"

  # Hot-adding a VPC NIC can briefly disrupt networking on the VM.
  # Wait for SSH to come back before trying to configure the interface.
  wait_for_ssh "$STAKE_IP" ada 120

  # Hot-added VPC interface needs OS-side static IP configuration.
  # Vultr VPC v1 assigns IPs API-side but doesn't provide DHCP for the host OS.
  # The VPC NIC may already have a link-local (169.254.x.x) IP from DHCP fallback,
  # so we identify it by MAC prefix (Vultr VPC NICs use 5a:00:xx).
  log "Configuring VPC interface on stake..."
  remote_ssh ada "$STAKE_IP" "
    # Skip if VPC IP is already configured
    if ip addr show | grep -q '$STAKE_VPC_IP'; then
      echo 'VPC IP already configured'
      exit 0
    fi
    # Find VPC NIC — it's the non-primary interface (not lo, not the one with the public IP)
    PUBLIC_DEV=\$(ip -4 route show default | awk '{print \$5; exit}')
    VPC_DEV=\$(ls /sys/class/net/ | grep -v lo | grep -v \"\$PUBLIC_DEV\" | head -1)
    if [ -z \"\$VPC_DEV\" ]; then
      echo 'ERROR: No VPC interface found' >&2
      exit 1
    fi
    echo \"Assigning $STAKE_VPC_IP/24 to \$VPC_DEV\"
    sudo ip addr add $STAKE_VPC_IP/24 dev \$VPC_DEV
    sudo ip link set \$VPC_DEV up
  "

  # Verify the VPC IP is reachable from the stake itself
  remote_ssh ada "$STAKE_IP" "ip addr show | grep -q '$STAKE_VPC_IP'" \
    || err "VPC IP $STAKE_VPC_IP not found on stake after configuration"
  log "VPC interface configured (${STAKE_VPC_IP})"
}

wait_for_ssh() {
  local ip="$1" user="${2:-root}" timeout="${3:-300}"
  log "Waiting for SSH at $user@$ip (timeout: ${timeout}s)"
  local deadline=$(( $(date +%s) + timeout ))

  while (( $(date +%s) < deadline )); do
    if ssh "${ssh_opts[@]}" -o ConnectTimeout=5 "$user@$ip" true 2>/dev/null; then
      log "SSH available at $user@$ip"
      return 0
    fi
    sleep 5
  done
  err "SSH to $user@$ip not available after ${timeout}s"
}

configure_installer_cache() {
  # After kexec, we're in the NixOS installer. Configure the nix-daemon to use
  # our S3 binary cache so the remote build pulls pre-built derivations instead
  # of rebuilding everything from source. This is the difference between a 30-min
  # install and a <1-min install. Also configures push so newly built derivations
  # (like the netboot initrd) get cached for future stakes.
  #
  # Key NixOS installer constraints:
  #   - /etc/nix/nix.conf is a symlink to the nix store (read-only)
  #   - /etc/systemd/system/ entries are nix store symlinks (read-only)
  #   - /root/.config/nix/nix.conf is user-level config (writable)
  #   - root is trusted-user, so daemon accepts extra-substituters from client config
  #   - systemctl set-environment injects env vars into all systemd services
  log "Configuring S3 binary cache in installer..."

  remote_ssh root "$STAKE_IP" "
    # AWS credentials for S3 binary cache access
    mkdir -p /root/.aws
    cat > /root/.aws/credentials << 'AWSEOF'
[default]
aws_access_key_id=$S3_ACCESS_KEY
aws_secret_access_key=$S3_SECRET_KEY
AWSEOF

    # Cache signing key for pushing built derivations
    cat > /root/.cache-signing-key << 'SIGNEOF'
$S3_SIGNING_KEY
SIGNEOF
    chmod 600 /root/.cache-signing-key

    # Post-build-hook: sign + upload every build to S3
    cat > /root/upload-to-cache.sh << 'HOOKEOF'
#!/bin/sh
set -eu
set -f
export AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials
export AWS_EC2_METADATA_DISABLED=true
if [ -f /root/.cache-signing-key ]; then
  nix store sign --key-file /root/.cache-signing-key \$OUT_PATHS
  nix copy --to '$S3_CACHE_SUBSTITUTER' \$OUT_PATHS
fi
HOOKEOF
    chmod +x /root/upload-to-cache.sh

    # Inject AWS credentials into nix-daemon via systemd environment
    systemctl set-environment AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials
    systemctl set-environment AWS_EC2_METADATA_DISABLED=true
    systemctl restart nix-daemon

    # User-level nix config: root is trusted-user so daemon accepts extra-substituters
    mkdir -p /root/.config/nix
    cat > /root/.config/nix/nix.conf << 'NIXEOF'
extra-substituters = $S3_CACHE_SUBSTITUTER
extra-trusted-public-keys = $S3_CACHE_PUBKEY
post-build-hook = /root/upload-to-cache.sh
NIXEOF
  "
  log "S3 binary cache configured in installer (pull + push)"
}

provision_stake() {
  # Ephemeral infect: kexec into NixOS installer, swap nix store overlay to
  # disk, build the system closure with S3 cache, then switch-to-configuration
  # to activate in place — no disko, no nixos-install, no reboot.
  log "Provisioning NixOS on stake VM at $STAKE_IP (ephemeral infect)"

  wait_for_ssh "$STAKE_IP" root 300

  # Phase 1: kexec into NixOS installer
  log "Phase 1: kexec into NixOS installer..."
  nixos-anywhere \
    --flake "$STAKE_KEXEC_FLAKE" \
    --build-on remote \
    --phases kexec \
    "root@$STAKE_IP"

  sleep 10
  wait_for_ssh "$STAKE_IP" root 120

  # Phase 2: Inject S3 binary cache so the build pulls pre-built derivations
  # from S3 instead of rebuilding everything from source.
  configure_installer_cache

  # Phase 3: Swap nix store overlay from tmpfs to disk.
  # The kexec installer uses squashfs (read-only) + tmpfs (writable) overlay
  # for /nix/store. Replace the tmpfs upper with a disk-backed upper so we
  # have enough space for the full system build (netboot images, custom kernel).
  log "Phase 3: swapping nix store overlay to disk..."
  remote_ssh root "$STAKE_IP" '
    set -euo pipefail
    mkfs.ext4 -q -F /dev/vda
    mkdir -p /mnt/disk
    mount /dev/vda /mnt/disk
    mkdir -p /mnt/disk/nix-upper /mnt/disk/nix-work

    LOWER=/nix/.ro-store
    UPPER=/nix/.rw-store/store

    if [ -d "$UPPER" ]; then
      echo "Copying overlay upper ($UPPER) to disk..."
      cp -a "$UPPER"/. /mnt/disk/nix-upper/ 2>/dev/null || true
    fi

    systemctl stop nix-daemon.socket nix-daemon.service
    umount -l /nix/store
    mount -t overlay overlay \
      -o "lowerdir=$LOWER,upperdir=/mnt/disk/nix-upper,workdir=/mnt/disk/nix-work" \
      /nix/store
    systemctl start nix-daemon.socket

    DISK_AVAIL=$(df -BG /mnt/disk | tail -1 | awk "{print \$4}")
    echo "nix store overlay: disk-backed at /dev/vda, ${DISK_AVAIL} available"
  '

  # Phase 4: Build the stake system closure and activate in place.
  # Uses seed-stake-kexec (no disko, no bootloader, declares /mnt/disk mount)
  # to avoid systemd mount unit conflicts with the overlay setup.
  #
  # NOTE: We bypass switch-to-configuration entirely. The NixOS 25.11 Rust
  # rewrite (switch-to-configuration-0.1.0) hangs at 100% CPU when run on
  # a kexec installer — likely due to the massive delta between the
  # installer's systemd state and the target config. Instead we run the
  # activation scripts directly and start services manually.
  log "Phase 4: building and activating stake system..."
  remote_ssh root "$STAKE_IP" "
    set -euo pipefail
    TOPLEVEL=\$(nix build --no-link --print-out-paths --refresh \\
      'github:joshperry/mynix#nixosConfigurations.seed-stake-kexec.config.system.build.toplevel')
    echo \"Built: \$TOPLEVEL\"

    # Point /run/current-system at the new closure
    ln -sfn \$TOPLEVEL /run/current-system

    # Source the new system's PATH so activation scripts find the right tools
    export PATH=\$TOPLEVEL/sw/bin:\$TOPLEVEL/sw/sbin:\$PATH

    # Run NixOS activation scripts (creates users, groups, /etc, tmpfiles, etc.)
    echo 'Running activation scripts...'
    \$TOPLEVEL/activate

    # Reload systemd to pick up new unit files deployed by activation
    systemctl daemon-reload

    # Set hostname
    hostname seed-stake

    # Start core infrastructure services first
    systemctl start systemd-resolved || true
    systemctl restart systemd-networkd || true

    # Install setuid/setgid wrappers (sudo, su, etc.)
    # NixOS manages wrappers via a systemd service, not activation scripts.
    # Must run after daemon-reload so systemd sees the new unit files.
    echo 'Installing security wrappers...'
    systemctl start suid-sgid-wrappers.service

    # Start application services
    systemctl start nginx || true
    systemctl start seed-register || true

    # Restart sshd last — this changes auth config (disables root login).
    # Must be after DNS and wrappers are working so ada can SSH in.
    systemctl restart sshd || true

    echo 'Activation complete'
  "

  sleep 5
  wait_for_ssh "$STAKE_IP" ada 120
  log "Stake activated (ephemeral infect)"
}

setup_stake() {
  local user="ada"

  log "Setting up stake environment"

  remote_ssh "$user" "$STAKE_IP" "rm -rf /tmp/workspace && mkdir -p /tmp/workspace"

  # Add GitHub SSH host key (git push needs it for host verification)
  remote_ssh "$user" "$STAKE_IP" "ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null"

  # Clone repos via SSH (uses agent-forwarded keys for both clone and push)
  log "Cloning repos on stake..."
  remote_ssh "$user" "$STAKE_IP" "git clone --depth 1 git@github.com:joshperry/mynix.git /tmp/workspace/mynix"
  remote_ssh "$user" "$STAKE_IP" "git clone git@github.com:loomtex/seed.git /tmp/workspace/seed"

  # Git identity (provision-tang commits sops changes to mynix)
  log "Setting up git identity..."
  remote_ssh "$user" "$STAKE_IP" "git config --global user.email 'ada@6bit.com' && git config --global user.name 'Ada'"

  # Export josh's GPG public key (sops creation rules require PGP encryption)
  log "Exporting GPG public key to stake..."
  gpg --export --armor 2EE325D71601671696EBF687E45953D34C8829ED \
    | remote_ssh "$user" "$STAKE_IP" "gpg --import 2>/dev/null && echo '2EE325D71601671696EBF687E45953D34C8829ED:6:' | gpg --import-ownertrust 2>/dev/null"

  # Copy age key for sops decryption
  log "Copying age key..."
  remote_ssh "$user" "$STAKE_IP" "mkdir -p /tmp/workspace/.config/sops/age"
  remote_scp "$AGE_KEY_FILE" "$user@$STAKE_IP:/tmp/workspace/.config/sops/age/keys.txt"

  # SSH agent forwarding (-A on remote_ssh) provides authentication for
  # connecting to targets. No key copying needed.

  # Copy Vultr API key for provision-cluster (puncher sops secrets + BM reinstall)
  log "Copying Vultr API key..."
  remote_scp "$VULTR_API_KEY_FILE" "$user@$STAKE_IP:/tmp/workspace/vultr-api-key"
  remote_ssh "$user" "$STAKE_IP" "chmod 600 /tmp/workspace/vultr-api-key"

  # Write AWS credentials for S3 Pulumi backend
  log "Writing S3 credentials..."
  remote_ssh "$user" "$STAKE_IP" "mkdir -p ~/.aws && cat > ~/.aws/credentials << AWSEOF
[default]
aws_access_key_id=$S3_ACCESS_KEY
aws_secret_access_key=$S3_SECRET_KEY
AWSEOF
chmod 600 ~/.aws/credentials"

  # Write Pulumi env file (sourced by remote commands — avoids quoting issues over SSH)
  log "Writing Pulumi env..."
  remote_ssh "$user" "$STAKE_IP" "cat > /tmp/workspace/pulumi.env << 'ENVEOF'
export PULUMI_BACKEND_URL='$PULUMI_BACKEND_URL'
export PULUMI_CONFIG_PASSPHRASE='$PULUMI_PASSPHRASE'
export NIX_CONFIG='experimental-features = nix-command flakes'
ENVEOF
chmod 600 /tmp/workspace/pulumi.env"

  # Install npm dependencies for Pulumi project
  log "Installing npm dependencies..."
  remote_ssh "$user" "$STAKE_IP" "cd /tmp/workspace/seed/infra && npm install"

  log "Stake environment ready"
}

# Phase 1: create VPC, SSH keys, reserved IPs. No stakeIp yet.
run_pulumi_infra() {
  local user="ada"

  log "Pulumi phase 1: creating VPC + infrastructure..."

  remote_ssh "$user" "$STAKE_IP" '
    set -euo pipefail
    source /tmp/workspace/pulumi.env

    cd /tmp/workspace/seed/infra

    pulumi login "$PULUMI_BACKEND_URL" 2>/dev/null
    pulumi stack select prod 2>/dev/null || pulumi stack init prod

    pulumi config set seed-infra:mynixDir /tmp/workspace/mynix -s prod

    # No stakeIp set — Pulumi only creates VPC, SSH keys, reserved IPs
    pulumi config rm seed-infra:stakeIp -s prod 2>/dev/null || true

    pulumi up -s prod -y --skip-preview
  '

  # Read VPC ID from Pulumi outputs
  PULUMI_VPC_ID="$(remote_ssh "$user" "$STAKE_IP" '
    set -euo pipefail
    source /tmp/workspace/pulumi.env
    cd /tmp/workspace/seed/infra
    pulumi login "$PULUMI_BACKEND_URL" >/dev/null 2>&1
    pulumi stack output vpcId -s prod
  ')"

  log "Pulumi phase 1 complete — VPC: $PULUMI_VPC_ID"
}

# Phase 2: create boot script, puncher, BM nodes (stakeIp is now set).
run_pulumi_machines() {
  local user="ada"

  log "Pulumi phase 2: creating machines (stakeIp=$STAKE_IP)..."

  remote_ssh "$user" "$STAKE_IP" "
    set -euo pipefail
    source /tmp/workspace/pulumi.env

    cd /tmp/workspace/seed/infra

    pulumi login \"\$PULUMI_BACKEND_URL\" 2>/dev/null
    pulumi stack select prod 2>/dev/null

    pulumi config set seed-infra:stakeIp '$STAKE_IP' -s prod
    pulumi config set seed-infra:stakePublicIp '$STAKE_IP' -s prod

    pulumi up -s prod -y --skip-preview
  "

  log "Pulumi phase 2 complete"
}

run_provision() {
  local user="ada"

  log "Running provision-cluster on stake..."

  remote_ssh "$user" "$STAKE_IP" '
    set -euo pipefail
    source /tmp/workspace/pulumi.env
    export SOPS_AGE_KEY_FILE="/tmp/workspace/.config/sops/age/keys.txt"
    export MYNIX_DIR="/tmp/workspace/mynix"
    export VULTR_API_KEY="$(cat /tmp/workspace/vultr-api-key)"

    cd /tmp/workspace/seed/infra

    pulumi login "$PULUMI_BACKEND_URL" 2>/dev/null
    pulumi stack select prod 2>/dev/null || pulumi stack init prod

    # Export manifest, then run the event-driven provisioner
    pulumi stack output manifest --json -s prod > /tmp/manifest.json
    npx tsx provision-cluster.ts --manifest /tmp/manifest.json
  '

  log "Provision-cluster completed"
}

detach_stake_from_vpc() {
  # Detach stake from VPC before destroying Pulumi resources.
  # Pulumi's VPC delete blocks while instances are still attached.
  if [[ ! -f "$STAKE_STATE_FILE" ]]; then
    return 0
  fi

  local stake_id
  stake_id="$(cat "$STAKE_STATE_FILE")"

  # Get stake's VPC attachments
  local vpcs
  vpcs="$(curl -sf "https://api.vultr.com/v2/instances/$stake_id/vpcs" \
    -H "Authorization: Bearer $VULTR_API_KEY" 2>/dev/null || echo '{"vpcs":[]}')"

  local vpc_ids
  vpc_ids="$(echo "$vpcs" | jq -r '.vpcs[].id // empty' 2>/dev/null)"

  if [[ -z "$vpc_ids" ]]; then
    log "Stake not attached to any VPC"
    return 0
  fi

  for vpc_id in $vpc_ids; do
    log "Detaching stake from VPC $vpc_id..."
    curl -sf -X POST "https://api.vultr.com/v2/instances/$stake_id/vpcs/detach" \
      -H "Authorization: Bearer $VULTR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"vpc_id\":\"$vpc_id\"}" || log "Warning: detach failed (may already be detached)"
  done

  # Wait a moment for Vultr to process the detach
  sleep 5
  log "Stake detached from VPC(s)"
}

destroy_pulumi_resources() {
  # Destroy all Pulumi-managed resources (VPC, VMs, IPs, etc.)
  # Requires stake to be running (runs Pulumi on stake) OR S3 creds available locally.
  local user="ada"

  if [[ -f "$STAKE_STATE_FILE" ]]; then
    local stake_id
    stake_id="$(cat "$STAKE_STATE_FILE")"
    local stake_ip
    stake_ip="$(vultr instance get "$stake_id" -o json 2>/dev/null | jq -r '.instance.main_ip' 2>/dev/null || echo "")"

    if [[ -n "$stake_ip" && "$stake_ip" != "null" && "$stake_ip" != "0.0.0.0" ]]; then
      # Try running pulumi destroy on the stake
      if ssh "${ssh_opts[@]}" -o ConnectTimeout=5 "$user@$stake_ip" "test -f /tmp/workspace/pulumi.env" 2>/dev/null; then
        log "Running pulumi destroy on stake..."
        remote_ssh "$user" "$stake_ip" '
          set -euo pipefail
          source /tmp/workspace/pulumi.env
          cd /tmp/workspace/seed/infra
          pulumi login "$PULUMI_BACKEND_URL" 2>/dev/null
          pulumi destroy -s prod -y --skip-preview 2>&1
        ' && return 0
        log "Warning: pulumi destroy on stake failed, trying local..."
      fi
    fi
  fi

  # Fallback: run pulumi destroy locally (we're in the flake devshell)
  log "Running pulumi destroy locally..."
  (
    cd "$SCRIPT_DIR"
    export PULUMI_BACKEND_URL="$PULUMI_BACKEND_URL"
    export PULUMI_CONFIG_PASSPHRASE="$PULUMI_PASSPHRASE"
    export VULTR_API_KEY
    if [[ ! -d node_modules ]]; then
      npm install --silent 2>/dev/null
    fi
    pulumi login "$PULUMI_BACKEND_URL" 2>/dev/null
    pulumi stack select prod 2>/dev/null || true
    pulumi destroy -s prod -y --skip-preview 2>&1
  )
}

destroy_stake() {
  if [[ ! -f "$STAKE_STATE_FILE" ]]; then
    log "No stake state file — nothing to destroy"
    return 0
  fi

  local id
  id="$(cat "$STAKE_STATE_FILE")"
  log "Destroying stake VM: $id"

  vultr instance delete "$id" || log "Warning: destroy failed (VM may already be gone)"
  rm -f "$STAKE_STATE_FILE"
  log "Stake destroyed"
}

teardown() {
  # Full teardown: detach stake from VPC → pulumi destroy → destroy stake.
  # Order matters: VPC deletion blocks while stake is attached.
  log "=== Tearing down cluster ==="

  # Step 1: detach stake from VPC (unblocks Pulumi's VPC delete)
  detach_stake_from_vpc

  # Step 2: destroy Pulumi resources (VPC, puncher, IPs, etc.)
  destroy_pulumi_resources

  # Step 3: destroy the stake VM itself (outside Pulumi)
  destroy_stake

  # Step 4: clean up provisioner ID file
  rm -f "$SCRIPT_DIR/.provisioner-id"

  log "=== Teardown complete ==="
}

# --- Main ---

main() {
  local skip_destroy=false
  local destroy_only=false
  local setup_only=false
  local do_teardown=false

  for arg in "$@"; do
    case "$arg" in
      --setup-only) setup_only=true ;;
      --skip-destroy) skip_destroy=true ;;
      --destroy-only) destroy_only=true ;;
      --teardown) do_teardown=true ;;
      *) err "Unknown argument: $arg" ;;
    esac
  done

  preflight

  if $do_teardown; then
    teardown
    exit 0
  fi

  if $destroy_only; then
    destroy_stake
    exit 0
  fi

  create_stake

  # If stake is already activated (hostname = seed-stake), skip provisioning.
  # The kexec installer has /etc/NIXOS too, so we check hostname instead.
  local needs_provision=true
  local current_hostname
  current_hostname="$(ssh "${ssh_opts[@]}" -o ConnectTimeout=5 "ada@$STAKE_IP" hostname 2>/dev/null || true)"
  if [[ "$current_hostname" == "seed-stake" ]]; then
    log "Stake already activated (hostname=seed-stake), skipping provision"
    needs_provision=false
  fi

  if $needs_provision; then
    provision_stake
  fi

  setup_stake

  if $setup_only; then
    log "Stake ready at $STAKE_IP"
    log ""
    log "To continue automated provisioning:"
    log "  ./provision.sh --skip-destroy"
    log ""
    log "Or SSH in and run manually:"
    log "  ssh -A ${ssh_opts[*]} ada@$STAKE_IP"
    exit 0
  fi

  # Phase 1: Pulumi creates VPC + infrastructure (no machines yet)
  run_pulumi_infra

  # Phase 2: Pulumi creates boot script + machines.
  # Stake doesn't need VPC — iPXE/phone-home use public IP, and stake SSHes
  # into targets over public IPs too. VPC attachment disrupts kexec networking.
  run_pulumi_machines

  # Event-driven provisioning
  run_provision

  if $skip_destroy; then
    log "Stake kept alive at $STAKE_IP (--skip-destroy)"
    log "Run: ./provision.sh --destroy-only  to clean up"
  else
    destroy_stake
  fi

  log "Done"
}

main "$@"
