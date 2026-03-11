#!/usr/bin/env bash
#
# provision.sh — Provision seed cluster from signi via ephemeral provisioner VM
#
# Creates a beefy VM in the same datacenter as the targets, provisions it with
# NixOS (nixos-anywhere), then runs Pulumi ON the provisioner so all builds and
# transfers happen in-datacenter. After completion, Pulumi state is copied back
# and the provisioner is destroyed.
#
# Usage:
#   ./provision.sh              # Full run: create provisioner, run Pulumi, destroy
#   ./provision.sh --skip-destroy   # Keep provisioner alive for debugging
#   ./provision.sh --destroy-only   # Just destroy an existing provisioner
#
# Prerequisites:
#   - Vultr API key at /run/secrets/ada/vultr-api-key (signi sops)
#   - Age key at ~/.config/sops/age/keys.txt
#   - SSH agent with key loaded (forwarded to provisioner for target access)
#   - mynix repo at $MYNIX_DIR (default: /agents/ada/projects/mynix)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Re-exec inside nix shell with required tools if nixos-anywhere isn't on PATH
if ! command -v nixos-anywhere &>/dev/null; then
  exec nix shell \
    nixpkgs#nixos-anywhere nixpkgs#sops nixpkgs#jq nixpkgs#rsync \
    nixpkgs#openssh nixpkgs#vultr-cli \
    -c bash "$0" "$@"
fi

SEED_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MYNIX_DIR="${MYNIX_DIR:-/agents/ada/projects/mynix}"
VULTR_API_KEY_FILE="${VULTR_API_KEY_FILE:-/run/secrets/ada/vultr-api-key}"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
PROVISIONER_STATE_FILE="$SCRIPT_DIR/.provisioner-id"

# Provisioner VM config
PROVISIONER_REGION="${PROVISIONER_REGION:-atl}"
PROVISIONER_PLAN="${PROVISIONER_PLAN:-vx1-m-8c-64g-480s}"
PROVISIONER_LABEL="seed-provisioner"
PROVISIONER_FLAKE="github:joshperry/mynix#seed-provisioner"
PROVISIONER_OS_ID=2136  # Debian 12

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

  # Decrypt Pulumi passphrase (needed for provisioner to run Pulumi)
  PULUMI_PASSPHRASE="$(sops --decrypt --extract '["pulumi-passphrase"]' "$MYNIX_DIR/secrets/pulumi-passphrase.yaml")"
  export PULUMI_PASSPHRASE
}

# --- Provisioner VM lifecycle ---

# Find the VPC ID for the seed cluster
get_vpc_id() {
  vultr instance list -o json | jq -r '
    .instances[]? | select(.label == "seed-tang-1" or .label == "seed-atl-1") |
    .vpc_ids[0] // empty' | head -1
}

create_provisioner() {
  if [[ -f "$PROVISIONER_STATE_FILE" ]]; then
    local existing_id
    existing_id="$(cat "$PROVISIONER_STATE_FILE")"
    log "Provisioner VM already exists: $existing_id"

    # Verify it's still alive
    local status
    status="$(vultr instance get "$existing_id" -o json 2>/dev/null | jq -r '.instance.status' 2>/dev/null || echo "gone")"
    if [[ "$status" != "gone" ]]; then
      PROVISIONER_ID="$existing_id"
      PROVISIONER_IP="$(vultr instance get "$existing_id" -o json | jq -r '.instance.main_ip')"
      log "Reusing existing provisioner at $PROVISIONER_IP (status: $status)"
      return 0
    else
      log "Stale state file — VM is gone, creating new one"
      rm -f "$PROVISIONER_STATE_FILE"
    fi
  fi

  log "Creating provisioner VM ($PROVISIONER_PLAN in $PROVISIONER_REGION)"

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
    --region "$PROVISIONER_REGION" \
    --plan "$PROVISIONER_PLAN" \
    --os "$PROVISIONER_OS_ID" \
    --label "$PROVISIONER_LABEL" \
    --host "$PROVISIONER_LABEL" \
    --ipv6 \
    "${ssh_key_args[@]}" \
    "${vpc_args[@]}" \
    -o json)"

  PROVISIONER_ID="$(echo "$output" | jq -r '.instance.id')"
  echo "$PROVISIONER_ID" > "$PROVISIONER_STATE_FILE"
  log "Created provisioner VM: $PROVISIONER_ID"

  # Wait for IP assignment
  log "Waiting for IP assignment..."
  local attempts=0
  while (( attempts < 60 )); do
    PROVISIONER_IP="$(vultr instance get "$PROVISIONER_ID" -o json | jq -r '.instance.main_ip')"
    if [[ "$PROVISIONER_IP" != "0.0.0.0" && "$PROVISIONER_IP" != "null" && -n "$PROVISIONER_IP" ]]; then
      break
    fi
    sleep 5
    attempts=$(( attempts + 1 ))
  done
  [[ "$PROVISIONER_IP" != "0.0.0.0" ]] || err "Provisioner IP not assigned after 5 minutes"
  log "Provisioner IP: $PROVISIONER_IP"
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

provision_provisioner() {
  log "Provisioning NixOS on provisioner VM at $PROVISIONER_IP"

  wait_for_ssh "$PROVISIONER_IP" root 300

  # nixos-anywhere --build-on remote: the provisioner VM (8c/64GB) builds its own
  # closure. The kexec phase sends a small NixOS installer from signi (~1GB), then
  # the VM builds everything from cache.nixos.org. Avoids sending the full closure
  # through signi's slow uplink.
  nixos-anywhere \
    --flake "$PROVISIONER_FLAKE" \
    --build-on remote \
    --phases kexec,disko,install,reboot \
    "root@$PROVISIONER_IP"

  log "Waiting for post-install reboot..."
  sleep 10
  wait_for_ssh "$PROVISIONER_IP" ada 300
  log "Provisioner NixOS installed and reachable"
}

setup_provisioner() {
  local user="ada"

  log "Setting up provisioner environment"

  # Clean + create workspace on provisioner (idempotent re-runs)
  remote_ssh "$user" "$PROVISIONER_IP" "rm -rf /tmp/workspace && mkdir -p /tmp/workspace /tmp/pulumi-state"

  # Clone repos from GitHub on the provisioner (fast — in-datacenter to GitHub)
  log "Cloning repos on provisioner..."
  remote_ssh "$user" "$PROVISIONER_IP" "git clone --depth 1 https://github.com/joshperry/mynix /tmp/workspace/mynix"
  remote_ssh "$user" "$PROVISIONER_IP" "git clone https://github.com/loomtex/seed /tmp/workspace/seed"

  # Copy Pulumi state (local backend)
  log "Copying Pulumi state..."
  rsync -az -e "ssh ${ssh_opts[*]}" \
    "$SCRIPT_DIR/.pulumi-state/" "$user@$PROVISIONER_IP:/tmp/pulumi-state/"

  # Copy age key for sops decryption
  log "Copying age key..."
  remote_ssh "$user" "$PROVISIONER_IP" "mkdir -p /tmp/workspace/.config/sops/age"
  remote_scp "$AGE_KEY_FILE" "$user@$PROVISIONER_IP:/tmp/workspace/.config/sops/age/keys.txt"

  # SSH agent forwarding (-A on remote_ssh) provides authentication for
  # connecting to targets. No key copying needed.

  # Install npm dependencies for Pulumi project
  log "Installing npm dependencies..."
  remote_ssh "$user" "$PROVISIONER_IP" "cd /tmp/workspace/seed/infra && npm install"

  log "Provisioner environment ready"
}

run_pulumi() {
  local user="ada"

  log "Running Pulumi on provisioner..."

  # Run Pulumi with all necessary env vars.
  # SOPS_AGE_KEY_FILE points to the copied age key.
  # MYNIX_DIR points to the cloned mynix repo on the provisioner.
  # Pulumi uses local file backend at /tmp/pulumi-state.
  remote_ssh "$user" "$PROVISIONER_IP" "
    set -euo pipefail
    export PULUMI_BACKEND_URL='file:///tmp/pulumi-state'
    export PULUMI_HOME='/tmp/pulumi-state/.home'
    export PULUMI_CONFIG_PASSPHRASE='$PULUMI_PASSPHRASE'
    export SOPS_AGE_KEY_FILE='/tmp/workspace/.config/sops/age/keys.txt'
    export MYNIX_DIR='/tmp/workspace/mynix'
    export NIX_CONFIG='experimental-features = nix-command flakes'

    cd /tmp/workspace/seed/infra

    pulumi login \"\$PULUMI_BACKEND_URL\" 2>/dev/null
    pulumi stack select prod 2>/dev/null || true

    # Override mynixDir to point to the cloned repo on the provisioner
    pulumi config set seed-infra:mynixDir /tmp/workspace/mynix -s prod

    pulumi up -s prod -y --skip-preview
  "

  log "Pulumi completed"
}

copy_state_back() {
  local user="ada"

  log "Copying Pulumi state back to signi..."

  rsync -az -e "ssh ${ssh_opts[*]}" \
    "$user@$PROVISIONER_IP:/tmp/pulumi-state/" "$SCRIPT_DIR/.pulumi-state/"

  log "Pulumi state synced"
}

destroy_provisioner() {
  if [[ ! -f "$PROVISIONER_STATE_FILE" ]]; then
    log "No provisioner state file — nothing to destroy"
    return 0
  fi

  local id
  id="$(cat "$PROVISIONER_STATE_FILE")"
  log "Destroying provisioner VM: $id"

  vultr instance delete "$id" || log "Warning: destroy failed (VM may already be gone)"
  rm -f "$PROVISIONER_STATE_FILE"
  log "Provisioner destroyed"
}

# --- Main ---

main() {
  local skip_destroy=false
  local destroy_only=false

  for arg in "$@"; do
    case "$arg" in
      --skip-destroy) skip_destroy=true ;;
      --destroy-only) destroy_only=true ;;
      *) err "Unknown argument: $arg" ;;
    esac
  done

  preflight

  if $destroy_only; then
    destroy_provisioner
    exit 0
  fi

  create_provisioner

  # If provisioner was just created (Debian), install NixOS.
  # If reusing an existing NixOS provisioner, skip.
  local needs_provision=true
  if ssh "${ssh_opts[@]}" -o ConnectTimeout=5 "ada@$PROVISIONER_IP" "test -f /etc/NIXOS" 2>/dev/null; then
    log "Provisioner already running NixOS, skipping nixos-anywhere"
    needs_provision=false
  fi

  if $needs_provision; then
    provision_provisioner
  fi

  setup_provisioner
  run_pulumi
  copy_state_back

  if $skip_destroy; then
    log "Provisioner kept alive at $PROVISIONER_IP (--skip-destroy)"
    log "Run: ./provision.sh --destroy-only  to clean up"
  else
    destroy_provisioner
  fi

  log "Done"
}

main "$@"
