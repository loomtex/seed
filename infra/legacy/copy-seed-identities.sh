#!/usr/bin/env bash
# Copy seed instance identities and data from one cluster to another.
#
# Copies:
#   - TPM age identity files (from tpm-identity PVCs)
#   - swtpm state (from host /var/lib/seed-controller/tpm/)
#   - Specified data PVCs (e.g. silo repos)
#
# Usage:
#   ./copy-seed-identities.sh <source-host> <target-host> [namespace]
#
# Examples:
#   ./copy-seed-identities.sh seed-dfw-1 ada@155.138.198.207
#   ./copy-seed-identities.sh seed-dfw-1 seed-atl-1 s-gaydazldmnsg

set -euo pipefail

SOURCE="${1:?Usage: $0 <source-host> <target-host> [namespace]}"
TARGET="${2:?Usage: $0 <source-host> <target-host> [namespace]}"
NS="${3:-s-gaydazldmnsg}"

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

ssrc() { ssh $SSH_OPTS "$SOURCE" "$@"; }
sdst() { ssh $SSH_OPTS "$TARGET" "$@"; }

echo "=== Copying seed identities from $SOURCE to $TARGET (namespace: $NS) ==="

# 1. Discover PVCs on both sides
echo ""
echo "--- Discovering PVCs ---"

SRC_PVCS=$(ssrc "sudo k3s kubectl get pvc -n $NS -o jsonpath='{range .items[*]}{.metadata.name}={.spec.volumeName}{\"\\n\"}{end}'")
DST_PVCS=$(sdst "sudo k3s kubectl get pvc -n $NS -o jsonpath='{range .items[*]}{.metadata.name}={.spec.volumeName}{\"\\n\"}{end}'")

# Build PVC name → volume name maps
declare -A SRC_VOL DST_VOL
while IFS='=' read -r name vol; do
  [ -n "$name" ] && SRC_VOL["$name"]="$vol"
done <<< "$SRC_PVCS"
while IFS='=' read -r name vol; do
  [ -n "$name" ] && DST_VOL["$name"]="$vol"
done <<< "$DST_PVCS"

# 2. Scale down instance deployments on target
echo ""
echo "--- Scaling down instances on target ---"
DEPLOYMENTS=$(sdst "sudo k3s kubectl get deployments -n $NS -o jsonpath='{range .items[*]}{.metadata.name}{\" \"}{end}'" 2>/dev/null || true)
if [ -n "$DEPLOYMENTS" ]; then
  sdst "sudo k3s kubectl scale deployment -n $NS $DEPLOYMENTS --replicas=0"
  echo "Waiting for pods to terminate..."
  sleep 10
fi

# 3. Copy TPM identity PVCs
echo ""
echo "--- Copying TPM identity PVCs ---"
STORAGE="/var/lib/rancher/k3s/storage"

for pvc_name in "${!SRC_VOL[@]}"; do
  if [[ "$pvc_name" != *-tpm-identity ]]; then
    continue
  fi

  src_vol="${SRC_VOL[$pvc_name]}"
  dst_vol="${DST_VOL[$pvc_name]:-}"

  if [ -z "$dst_vol" ]; then
    echo "  SKIP $pvc_name (no matching PVC on target)"
    continue
  fi

  src_path="$STORAGE/${src_vol}_${NS}_${pvc_name}"
  dst_path="$STORAGE/${dst_vol}_${NS}_${pvc_name}"

  echo "  $pvc_name: $src_vol -> $dst_vol"
  ssrc "sudo tar -C '$src_path' -cf - ." | sdst "sudo tar -C '$dst_path' -xf -"
done

# 4. Copy swtpm host state
echo ""
echo "--- Copying swtpm state ---"
TPM_DIR="/var/lib/seed-controller/tpm"

# Get list of swtpm dirs for this namespace
SRC_TPM_DIRS=$(ssrc "sudo ls '$TPM_DIR' 2>/dev/null | grep '^${NS}-'" || true)

if [ -n "$SRC_TPM_DIRS" ]; then
  sdst "sudo mkdir -p '$TPM_DIR'"
  # shellcheck disable=SC2086
  ssrc "sudo tar -C '$TPM_DIR' -cf - $SRC_TPM_DIRS" | sdst "sudo tar -C '$TPM_DIR' -xf -"
  echo "  Copied: $SRC_TPM_DIRS"
else
  echo "  No swtpm state found for $NS"
fi

# 5. Copy data PVCs (silo repos, etc.)
echo ""
echo "--- Copying data PVCs ---"

# List of data PVCs to copy (add more as needed)
DATA_PVCS=("seed-silo-repos")

for pvc_name in "${DATA_PVCS[@]}"; do
  src_vol="${SRC_VOL[$pvc_name]:-}"
  dst_vol="${DST_VOL[$pvc_name]:-}"

  if [ -z "$src_vol" ] || [ -z "$dst_vol" ]; then
    echo "  SKIP $pvc_name (missing on source or target)"
    continue
  fi

  src_path="$STORAGE/${src_vol}_${NS}_${pvc_name}"
  dst_path="$STORAGE/${dst_vol}_${NS}_${pvc_name}"

  src_size=$(ssrc "sudo du -sh '$src_path' 2>/dev/null | cut -f1" || echo "?")
  echo "  $pvc_name ($src_size): $src_vol -> $dst_vol"
  ssrc "sudo tar -C '$src_path' -cf - ." | sdst "sudo tar -C '$dst_path' -xf -"
done

# 6. Scale deployments back up
echo ""
echo "--- Scaling instances back up ---"
if [ -n "$DEPLOYMENTS" ]; then
  sdst "sudo k3s kubectl scale deployment -n $NS $DEPLOYMENTS --replicas=1"
fi

echo ""
echo "=== Done. Instances restarting with restored identities. ==="
