#!/usr/bin/env bash
#
# provision-stake.sh — Provision the stake VM via ephemeral infect
#
# Creates a Debian VM on Vultr, kexecs into NixOS installer, swaps nix
# store overlay to disk, builds the seed-stake system closure ON the
# target (never on signi), and activates in place. No disko, no
# nixos-install, no reboot — the stake runs from the kexec activation
# until destroyed.
#
# Usage:
#   provision-stake                        # Full: create VM + provision
#   provision-stake --ip <ip>              # Skip VM creation, provision existing Debian
#   provision-stake --skip-kexec --ip <ip> # Skip kexec (already in NixOS installer)
#
# Prerequisites:
#   - Vultr API key at /run/secrets/ada/vultr-api-key
#   - sops age key at ~/.config/sops/age/keys.txt
#   - nixos-anywhere on PATH (provided by flake devShell)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VULTR_API_KEY_FILE="${VULTR_API_KEY_FILE:-/run/secrets/ada/vultr-api-key}"

# Cluster topology
STAKE_PLAN="vc2-6c-16gb"
REGION="atl"
VPC_ID=$(awk '/^\| ID \|/ {print $4}' "$INFRA_DIR/.state/atl.md" | head -1)
FLAKE_URL="github:loomtex/seed?dir=infra"
STAKE_TOPLEVEL="$FLAKE_URL#nixosConfigurations.seed-stake.config.system.build.toplevel"

# S3 binary cache
S3_CACHE_URL="s3://seed-nix-cache?endpoint=atl2.vultrobjects.com&region=us-east-1&profile=default"
S3_CACHE_PUBKEY="seed-cache-1:HmHh2GMeZTBXufX8RRs30bBNVB75+QfkgFllazC365E="

# --- Helpers ---

log() { echo "==> $*" >&2; }
err() { echo "ERROR: $*" >&2; exit 1; }

ssh_opts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

remote_ssh() {
  local user="$1" ip="$2"
  shift 2
  ssh "${ssh_opts[@]}" "$user@$ip" "$@"
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

decrypt_secret() {
  sops --decrypt --extract "$1" "$INFRA_DIR/secrets/seed-system.yaml"
}

# --- Parse args ---

STAKE_IP=""
SKIP_CREATE=false
SKIP_KEXEC=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip) STAKE_IP="$2"; SKIP_CREATE=true; shift 2 ;;
    --skip-kexec) SKIP_KEXEC=true; shift ;;
    *) err "Unknown arg: $1" ;;
  esac
done

# --- Phase 0: Decrypt S3 credentials ---

log "Decrypting S3 credentials from sops..."
S3_ACCESS_KEY=$(decrypt_secret '["seed"]["s3-access-key"]')
S3_SECRET_KEY=$(decrypt_secret '["seed"]["s3-secret-key"]')
S3_SIGNING_KEY=$(decrypt_secret '["seed"]["cache-signing-key"]')
log "Credentials decrypted"

# --- Phase 1: Create VM (if needed) ---

if ! $SKIP_CREATE; then
  if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "*(to" ]; then
    err "VPC ID not found in .state/atl.md — create VPC first"
  fi

  log "Creating stake VM (plan: $STAKE_PLAN, region: $REGION, VPC: $VPC_ID)"
  export VULTR_API_KEY_FILE
  RESULT=$(bash "$SCRIPT_DIR/vultr.sh" create-vm seed-stake "$STAKE_PLAN" "$REGION" "$VPC_ID" 2136)
  STAKE_VULTR_ID=$(echo "$RESULT" | jq -r '.instance.id')
  log "Created VM: $STAKE_VULTR_ID"

  # Poll for IP assignment
  log "Waiting for IP assignment..."
  for i in $(seq 1 60); do
    VULTR_API_KEY=$(cat "$VULTR_API_KEY_FILE")
    INFO=$(curl -sf -H "Authorization: Bearer $VULTR_API_KEY" "https://api.vultr.com/v2/instances/$STAKE_VULTR_ID")
    STAKE_IP=$(echo "$INFO" | jq -r '.instance.main_ip')
    STATUS=$(echo "$INFO" | jq -r '.instance.status')
    if [ "$STAKE_IP" != "0.0.0.0" ] && [ "$STAKE_IP" != "null" ] && [ -n "$STAKE_IP" ]; then
      log "IP assigned: $STAKE_IP (status: $STATUS)"
      break
    fi
    sleep 5
  done

  if [ -z "$STAKE_IP" ] || [ "$STAKE_IP" = "0.0.0.0" ]; then
    err "IP not assigned after 5 minutes"
  fi

  log "Waiting for SSH on Debian..."
  wait_for_ssh "$STAKE_IP" root 300
else
  log "Using existing VM at $STAKE_IP"
  if ! $SKIP_KEXEC; then
    wait_for_ssh "$STAKE_IP" root 60
  fi
fi

# --- Phase 2: Kexec into NixOS installer ---

if ! $SKIP_KEXEC; then
  log "Phase 2: kexec into NixOS installer..."
  nixos-anywhere \
    --flake "$FLAKE_URL#seed-stake" \
    --build-on remote \
    --phases kexec \
    "root@$STAKE_IP"

  sleep 10
  wait_for_ssh "$STAKE_IP" root 120
fi

# --- Phase 3: Configure S3 cache in installer ---

log "Phase 3: Configuring S3 binary cache in installer..."
remote_ssh root "$STAKE_IP" "
  # AWS credentials for S3 access
  mkdir -p /root/.aws
  cat > /root/.aws/credentials << 'AWSEOF'
[default]
aws_access_key_id=$S3_ACCESS_KEY
aws_secret_access_key=$S3_SECRET_KEY
AWSEOF

  # Cache signing key
  cat > /root/.cache-signing-key << 'SIGNEOF'
$S3_SIGNING_KEY
SIGNEOF
  chmod 600 /root/.cache-signing-key

  # Post-build-hook: sign + upload every build to S3
  cat > /root/upload-to-cache.sh << 'HOOKEOF'
#!/bin/sh
set -u
set -f
export AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials
export AWS_EC2_METADATA_DISABLED=true
if [ -f /root/.cache-signing-key ]; then
  nix store sign --key-file /root/.cache-signing-key \$OUT_PATHS 2>/dev/null || true
  nix copy --to '$S3_CACHE_URL' \$OUT_PATHS 2>/dev/null || true
fi
HOOKEOF
  chmod +x /root/upload-to-cache.sh

  # Inject AWS env into nix-daemon
  systemctl set-environment AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials
  systemctl set-environment AWS_EC2_METADATA_DISABLED=true
  systemctl restart nix-daemon

  # User-level nix config (root is trusted-user)
  mkdir -p /root/.config/nix
  cat > /root/.config/nix/nix.conf << 'NIXEOF'
extra-substituters = $S3_CACHE_URL
extra-trusted-public-keys = $S3_CACHE_PUBKEY
post-build-hook = /root/upload-to-cache.sh
NIXEOF
"
log "S3 binary cache configured in installer (pull + push)"

# --- Phase 4: Swap nix store overlay to disk ---

log "Phase 4: Swapping nix store overlay to disk..."
remote_ssh root "$STAKE_IP" '
  set -euo pipefail
  umount -f /dev/vda 2>/dev/null || true
  umount -f /mnt/disk 2>/dev/null || true
  mkfs.ext4 -q -F /dev/vda
  mkdir -p /mnt/disk
  mount /dev/vda /mnt/disk
  mkdir -p /mnt/disk/nix-upper /mnt/disk/nix-work

  LOWER=/nix/.ro-store
  UPPER=/nix/.rw-store/store

  if [ -d "$UPPER" ]; then
    echo "Copying overlay upper to disk..."
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

# --- Phase 5: Build and activate ---

log "Phase 5: Building and activating stake system..."
remote_ssh root "$STAKE_IP" "
  set -euo pipefail
  TOPLEVEL=\$(nix build --no-link --print-out-paths --refresh \\
    '$STAKE_TOPLEVEL')
  echo \"Built: \$TOPLEVEL\"

  # Point /run/current-system at the new closure
  ln -sfn \$TOPLEVEL /run/current-system

  # Source the new system's PATH
  export PATH=\$TOPLEVEL/sw/bin:\$TOPLEVEL/sw/sbin:\$PATH

  # Run NixOS activation scripts (users, groups, /etc, tmpfiles)
  echo 'Running activation scripts...'
  \$TOPLEVEL/activate

  # Reload systemd
  systemctl daemon-reload

  # Set hostname
  hostname seed-stake

  # Fix DNS: activation replaces resolv.conf with systemd-resolved stub
  # but systemd-resolved doesn't run in kexec. Use real nameservers.
  rm -f /etc/resolv.conf
  echo 'nameserver 1.1.1.1' > /etc/resolv.conf
  echo 'nameserver 8.8.8.8' >> /etc/resolv.conf

  # Restart nix-daemon with fixed DNS
  systemctl restart nix-daemon.socket nix-daemon.service || true

  # Install setuid/setgid wrappers (sudo, su)
  echo 'Installing security wrappers...'
  systemctl start suid-sgid-wrappers.service

  # Start VPC NIC configuration
  systemctl start seed-vpc || true

  # Start application services
  systemctl start nginx || true
  systemctl start seed-register || true

  # Restart sshd last (changes auth config)
  systemctl restart sshd || true

  echo 'Activation complete'
"

# --- Phase 6: Re-inject S3 credentials after activation ---

log "Phase 6: Configuring S3 cache for activated system..."
sleep 3
wait_for_ssh "$STAKE_IP" ada 60

remote_ssh ada "$STAKE_IP" "
  sudo mkdir -p /root/.aws
  sudo tee /root/.aws/credentials > /dev/null << 'AWSEOF'
[default]
aws_access_key_id=$S3_ACCESS_KEY
aws_secret_access_key=$S3_SECRET_KEY
AWSEOF

  sudo tee /root/.cache-signing-key > /dev/null << 'SIGNEOF'
$S3_SIGNING_KEY
SIGNEOF
  sudo chmod 600 /root/.cache-signing-key

  sudo tee /root/upload-to-cache.sh > /dev/null << 'HOOKEOF'
#!/bin/sh
set -u
set -f
export AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials
export AWS_EC2_METADATA_DISABLED=true
if [ -f /root/.cache-signing-key ]; then
  nix store sign --key-file /root/.cache-signing-key \$OUT_PATHS 2>/dev/null || true
  nix copy --to '$S3_CACHE_URL' \$OUT_PATHS 2>/dev/null || true
fi
HOOKEOF
  sudo chmod +x /root/upload-to-cache.sh

  # Inject env vars into nix-daemon
  sudo systemctl set-environment AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials
  sudo systemctl set-environment AWS_EC2_METADATA_DISABLED=true

  # Add post-build-hook to nix config
  sudo mkdir -p /root/.config/nix
  sudo tee /root/.config/nix/nix.conf > /dev/null << 'NIXEOF'
post-build-hook = /root/upload-to-cache.sh
NIXEOF

  sudo systemctl restart nix-daemon.socket nix-daemon.service
"
log "S3 cache configured (pull + push)"

# --- Phase 7: Verify ---

log "Phase 7: Verifying stake..."
HOSTNAME=$(remote_ssh ada "$STAKE_IP" "hostname")
if [ "$HOSTNAME" != "seed-stake" ]; then
  err "Hostname mismatch: expected seed-stake, got $HOSTNAME"
fi

VPC_OK=$(remote_ssh ada "$STAKE_IP" "ip addr show | grep '10.0.0.2' || echo 'no-vpc'")
if echo "$VPC_OK" | grep -q "no-vpc"; then
  log "WARNING: VPC NIC not configured (may need manual seed-vpc start)"
else
  log "VPC NIC configured: 10.0.0.2/24"
fi

# Check nginx (netboot)
NGINX_OK=$(remote_ssh ada "$STAKE_IP" "curl -so /dev/null -w '%{http_code}' http://localhost:8080/ 2>/dev/null || echo 'down'")
if [ "$NGINX_OK" = "200" ]; then
  log "Netboot HTTP: serving on :8080"
else
  log "WARNING: nginx not responding (netboot may not have built)"
fi

# Check registration endpoint
REG_OK=$(remote_ssh ada "$STAKE_IP" "curl -so /dev/null -w '%{http_code}' http://localhost:8081/ 2>/dev/null || echo 'down'")
log "Registration endpoint: $REG_OK"

log ""
log "Stake provisioned at $STAKE_IP"
log "SSH: ssh ada@$STAKE_IP"
if [ -n "${STAKE_VULTR_ID:-}" ]; then
  log "Vultr ID: $STAKE_VULTR_ID"
fi
