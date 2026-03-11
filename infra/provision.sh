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
#
# Prerequisites:
#   - Vultr API key at /run/secrets/ada/vultr-api-key (signi sops)
#   - Age key at ~/.config/sops/age/keys.txt
#   - SSH agent with key loaded (forwarded to stake for target access)
#   - mynix repo at $MYNIX_DIR (default: /agents/ada/projects/mynix)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Re-exec inside nix shell with required tools if nixos-anywhere isn't on PATH
if ! command -v nixos-anywhere &>/dev/null; then
  exec nix shell \
    nixpkgs#nixos-anywhere nixpkgs#sops nixpkgs#jq \
    nixpkgs#openssh nixpkgs#vultr-cli \
    -c bash "$0" "$@"
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
STAKE_PLAN="${STAKE_PLAN:-vx1-m-8c-64g-480s}"
STAKE_LABEL="seed-stake"
STAKE_FLAKE="github:joshperry/mynix#seed-stake"
STAKE_OS_ID=2136  # Debian 12

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
}

# --- Stake VM lifecycle ---

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
      STAKE_IP="$(vultr instance get "$existing_id" -o json | jq -r '.instance.main_ip')"
      log "Reusing existing stake at $STAKE_IP (status: $status)"
      return 0
    else
      log "Stale state file — VM is gone, creating new one"
      rm -f "$STAKE_STATE_FILE"
    fi
  fi

  log "Creating stake VM ($STAKE_PLAN in $STAKE_REGION)"

  # Find SSH key IDs
  local ssh_key_args=()
  while IFS= read -r key_id; do
    [[ -n "$key_id" ]] && ssh_key_args+=(--ssh-keys "$key_id")
  done < <(vultr ssh-key list -o json | jq -r '.ssh_keys[].id')

  # Find VPC ID
  local vpc_args=()
  local vpc_id
  vpc_id="$(vultr vpc list -o json | jq -r '.vpcs[] | select(.description == "Seed cluster internal network") | .id' | head -1)"
  if [[ -n "$vpc_id" ]]; then
    vpc_args=(--vpc-ids "$vpc_id" --vpc-enable)
  fi

  # Create instance
  local output
  output="$(vultr instance create \
    --region "$STAKE_REGION" \
    --plan "$STAKE_PLAN" \
    --os "$STAKE_OS_ID" \
    --label "$STAKE_LABEL" \
    --host "$STAKE_LABEL" \
    --ipv6 \
    "${ssh_key_args[@]}" \
    "${vpc_args[@]}" \
    -o json)"

  STAKE_ID="$(echo "$output" | jq -r '.instance.id')"
  echo "$STAKE_ID" > "$STAKE_STATE_FILE"
  log "Created stake VM: $STAKE_ID"

  # Wait for IP assignment
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
  log "Stake IP: $STAKE_IP"
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

provision_stake() {
  log "Provisioning NixOS on stake VM at $STAKE_IP"

  wait_for_ssh "$STAKE_IP" root 300

  # nixos-anywhere --build-on remote: the stake VM (8c/64GB) builds its own
  # closure. The kexec phase sends a small NixOS installer from signi (~1GB), then
  # the VM builds everything from cache.nixos.org. Avoids sending the full closure
  # through signi's slow uplink.
  nixos-anywhere \
    --flake "$STAKE_FLAKE" \
    --build-on remote \
    --phases kexec,disko,install,reboot \
    "root@$STAKE_IP"

  log "Waiting for post-install reboot..."
  sleep 10
  wait_for_ssh "$STAKE_IP" ada 300
  log "Stake NixOS installed and reachable"
}

setup_stake() {
  local user="ada"

  log "Setting up stake environment"

  # Clean + create workspace on stake (idempotent re-runs)
  remote_ssh "$user" "$STAKE_IP" "rm -rf /tmp/workspace && mkdir -p /tmp/workspace"

  # Clone repos from GitHub on the stake (fast — in-datacenter to GitHub)
  log "Cloning repos on stake..."
  remote_ssh "$user" "$STAKE_IP" "git clone --depth 1 https://github.com/joshperry/mynix /tmp/workspace/mynix"
  remote_ssh "$user" "$STAKE_IP" "git clone https://github.com/loomtex/seed /tmp/workspace/seed"

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

  # Install npm dependencies for Pulumi project
  log "Installing npm dependencies..."
  remote_ssh "$user" "$STAKE_IP" "cd /tmp/workspace/seed/infra && npm install"

  log "Stake environment ready"
}

run_pulumi() {
  local user="ada"

  log "Running Pulumi on stake..."

  # Set the stakeIp config before running Pulumi.
  # This tells Pulumi to point iPXE boot scripts at this stake VM.
  remote_ssh "$user" "$STAKE_IP" "
    set -euo pipefail
    export PULUMI_BACKEND_URL='$PULUMI_BACKEND_URL'
    export PULUMI_CONFIG_PASSPHRASE='$PULUMI_PASSPHRASE'
    export NIX_CONFIG='experimental-features = nix-command flakes'

    cd /tmp/workspace/seed/infra

    pulumi login \"\$PULUMI_BACKEND_URL\" 2>/dev/null
    pulumi stack select prod 2>/dev/null || pulumi stack init prod

    # Override settings for this run
    pulumi config set seed-infra:mynixDir /tmp/workspace/mynix -s prod
    pulumi config set seed-infra:stakeIp '$STAKE_IP' -s prod

    pulumi up -s prod -y --skip-preview
  "

  log "Pulumi completed"
}

run_provision() {
  local user="ada"

  log "Running provision-cluster on stake..."

  remote_ssh "$user" "$STAKE_IP" "
    set -euo pipefail
    export PULUMI_BACKEND_URL='$PULUMI_BACKEND_URL'
    export PULUMI_CONFIG_PASSPHRASE='$PULUMI_PASSPHRASE'
    export SOPS_AGE_KEY_FILE='/tmp/workspace/.config/sops/age/keys.txt'
    export MYNIX_DIR='/tmp/workspace/mynix'
    export NIX_CONFIG='experimental-features = nix-command flakes'
    export VULTR_API_KEY=\"\$(cat /tmp/workspace/vultr-api-key)\"

    cd /tmp/workspace/seed/infra

    pulumi login \"\$PULUMI_BACKEND_URL\" 2>/dev/null
    pulumi stack select prod 2>/dev/null || pulumi stack init prod

    # Export manifest, then run the event-driven provisioner
    pulumi stack output manifest --json -s prod > /tmp/manifest.json
    npx tsx provision-cluster.ts --manifest /tmp/manifest.json
  "

  log "Provision-cluster completed"
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

# --- Main ---

main() {
  local skip_destroy=false
  local destroy_only=false
  local setup_only=false

  for arg in "$@"; do
    case "$arg" in
      --setup-only) setup_only=true ;;
      --skip-destroy) skip_destroy=true ;;
      --destroy-only) destroy_only=true ;;
      *) err "Unknown argument: $arg" ;;
    esac
  done

  preflight

  if $destroy_only; then
    destroy_stake
    exit 0
  fi

  create_stake

  # If stake was just created (Debian), install NixOS.
  # If reusing an existing NixOS stake, skip.
  local needs_provision=true
  if ssh "${ssh_opts[@]}" -o ConnectTimeout=5 "ada@$STAKE_IP" "test -f /etc/NIXOS" 2>/dev/null; then
    log "Stake already running NixOS, skipping nixos-anywhere"
    needs_provision=false
  fi

  if $needs_provision; then
    provision_stake
  fi

  setup_stake

  if $setup_only; then
    log "Stake ready at $STAKE_IP"
    log ""
    log "SSH in and run Pulumi manually:"
    log "  ssh -A ${ssh_opts[*]} ada@$STAKE_IP"
    log ""
    log "Then on the stake:"
    log "  export PULUMI_BACKEND_URL='$PULUMI_BACKEND_URL'"
    log "  export PULUMI_CONFIG_PASSPHRASE='<passphrase>'"
    log "  export SOPS_AGE_KEY_FILE='/tmp/workspace/.config/sops/age/keys.txt'"
    log "  export MYNIX_DIR='/tmp/workspace/mynix'"
    log "  export NIX_CONFIG='experimental-features = nix-command flakes'"
    log "  cd /tmp/workspace/seed/infra"
    log "  pulumi login \$PULUMI_BACKEND_URL"
    log "  pulumi stack select prod"
    log "  pulumi config set seed-infra:mynixDir /tmp/workspace/mynix -s prod"
    log "  pulumi config set seed-infra:stakeIp $STAKE_IP -s prod"
    log "  pulumi up -s prod -y --skip-preview"
    log ""
    log "Then run provisioning:"
    log "  pulumi stack output manifest --json -s prod > /tmp/manifest.json"
    log "  npx tsx provision-cluster.ts --manifest /tmp/manifest.json"
    log ""
    log "When done:"
    log "  ./provision.sh --destroy-only"
    exit 0
  fi

  run_pulumi
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
