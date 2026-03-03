#!/usr/bin/env bash
# Seed controller — reconciles NixOS instances into Kata pods on k3s
#
# Stateless: all state lives in k8s labels. On each loop:
#   1. Eval + build each instance from the flake
#   2. Compute a generation hash from the set of image store paths
#   3. Skip if generation matches what's already deployed
#   4. Apply pods, PVCs, and services with generation labels
#   5. Reap resources with non-matching generation (except PVCs)
set -euo pipefail

FLAKE_PATH="${SEED_FLAKE_PATH:?SEED_FLAKE_PATH must be set}"
INTERVAL="${SEED_INTERVAL:-30}"
NAMESPACE="${SEED_NAMESPACE:-default}"
SYSTEM="${SEED_SYSTEM:-x86_64-linux}"

LABEL_MANAGED="seed.loomtex.com/managed-by=seed"

log() { echo "[seed] $(date -Iseconds) $*"; }
die() { log "FATAL: $*"; exit 1; }

# Wait for k3s API to be reachable
wait_for_k3s() {
  log "waiting for k3s API..."
  until kubectl get nodes &>/dev/null; do
    sleep 5
  done
  log "k3s API ready"
}

# Get generation hash currently deployed (from any seed-managed pod)
deployed_generation() {
  kubectl get pods -n "$NAMESPACE" \
    -l "$LABEL_MANAGED" \
    -o jsonpath='{.items[0].metadata.labels.seed\.loomtex\.com/generation}' 2>/dev/null || true
}

# Compute generation hash from a sorted list of "name=storepath" pairs
compute_generation() {
  # stdin: sorted lines of "name=<store-path>"
  sha256sum | cut -c1-12
}

# Get the image ref currently running for an instance
running_image_ref() {
  local name=$1
  kubectl get pod "seed-${name}" -n "$NAMESPACE" \
    -o jsonpath='{.spec.containers[0].image}' 2>/dev/null || true
}

# Generate pod manifest as JSON
generate_pod() {
  local name=$1 image_ref=$2 gen=$3 vcpus=$4 memory=$5

  jq -n \
    --arg name "seed-${name}" \
    --arg instance "$name" \
    --arg gen "$gen" \
    --arg image "$image_ref" \
    --arg vcpus "$vcpus" \
    --arg memory "$memory" \
    '{
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: $name,
        namespace: "'"$NAMESPACE"'",
        labels: {
          "seed.loomtex.com/managed-by": "seed",
          "seed.loomtex.com/instance": $instance,
          "seed.loomtex.com/generation": $gen
        },
        annotations: {
          "io.katacontainers.config.hypervisor.default_vcpus": $vcpus,
          "io.katacontainers.config.hypervisor.default_memory": $memory
        }
      },
      spec: {
        runtimeClassName: "kata",
        restartPolicy: "Always",
        terminationGracePeriodSeconds: 10,
        containers: [{
          name: $instance,
          image: $image,
          stdin: true,
          tty: true
        }]
      }
    }'
}

# Generate PVC manifest as JSON
generate_pvc() {
  local instance=$1 key=$2 size=$3 gen=$4
  local pvc_name="seed-${instance}-${key}"

  jq -n \
    --arg name "$pvc_name" \
    --arg instance "$instance" \
    --arg gen "$gen" \
    --arg size "$size" \
    '{
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: $name,
        namespace: "'"$NAMESPACE"'",
        labels: {
          "seed.loomtex.com/managed-by": "seed",
          "seed.loomtex.com/instance": $instance,
          "seed.loomtex.com/generation": $gen
        }
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: $size
          }
        }
      }
    }'
}

# Generate service manifest as JSON
generate_service() {
  local instance=$1 gen=$2
  local ports_json=$3

  jq -n \
    --arg name "seed-${instance}" \
    --arg instance "$instance" \
    --arg gen "$gen" \
    --argjson ports "$ports_json" \
    '{
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: $name,
        namespace: "'"$NAMESPACE"'",
        labels: {
          "seed.loomtex.com/managed-by": "seed",
          "seed.loomtex.com/instance": $instance,
          "seed.loomtex.com/generation": $gen
        }
      },
      spec: {
        selector: {
          "seed.loomtex.com/instance": $instance
        },
        ports: $ports
      }
    }'
}

# Add volume mounts to a pod manifest for storage entries
add_volumes_to_pod() {
  local pod_json=$1 instance=$2
  local storage_json=$3

  local keys
  keys=$(echo "$storage_json" | jq -r 'keys[]')
  [ -z "$keys" ] && { echo "$pod_json"; return; }

  local volumes="[]"
  local mounts="[]"

  for key in $keys; do
    local pvc_name="seed-${instance}-${key}"
    local mount_point
    mount_point=$(echo "$storage_json" | jq -r --arg k "$key" '.[$k].mountPoint')

    volumes=$(echo "$volumes" | jq \
      --arg name "$key" \
      --arg pvc "$pvc_name" \
      '. + [{ name: $name, persistentVolumeClaim: { claimName: $pvc } }]')

    mounts=$(echo "$mounts" | jq \
      --arg name "$key" \
      --arg mp "$mount_point" \
      '. + [{ name: $name, mountPath: $mp }]')
  done

  echo "$pod_json" | jq \
    --argjson vols "$volumes" \
    --argjson mnts "$mounts" \
    '.spec.volumes = $vols | .spec.containers[0].volumeMounts = $mnts'
}

# Reap resources whose generation doesn't match current
reap_old() {
  local gen=$1

  local old_pods
  old_pods=$(kubectl get pods -n "$NAMESPACE" \
    -l "$LABEL_MANAGED" \
    -o json 2>/dev/null \
    | jq -r --arg gen "$gen" \
      '.items[] | select(.metadata.labels["seed.loomtex.com/generation"] != $gen) | .metadata.name')

  for pod in $old_pods; do
    log "reaping pod: $pod"
    kubectl delete pod "$pod" -n "$NAMESPACE" --grace-period=10
  done

  local old_svcs
  old_svcs=$(kubectl get services -n "$NAMESPACE" \
    -l "$LABEL_MANAGED" \
    -o json 2>/dev/null \
    | jq -r --arg gen "$gen" \
      '.items[] | select(.metadata.labels["seed.loomtex.com/generation"] != $gen) | .metadata.name')

  for svc in $old_svcs; do
    log "reaping service: $svc"
    kubectl delete service "$svc" -n "$NAMESPACE"
  done

  # PVCs are never reaped — delete manually if needed
}

# Reconcile a single instance. Outputs "name=storepath" on stdout for hashing.
reconcile_instance() {
  local name=$1 gen=$2

  log "[$name] building image..."
  local image_path
  image_path=$(nix build "${FLAKE_PATH}#seeds.${SYSTEM}.${name}.image" --no-link --print-out-paths 2>&1) \
    || { log "[$name] build failed: $image_path"; return 1; }

  local image_ref="nix:0${image_path}"

  log "[$name] evaluating metadata..."
  local meta_json
  meta_json=$(nix eval "${FLAKE_PATH}#seeds.${SYSTEM}.${name}.meta" --json 2>&1) \
    || { log "[$name] eval failed: $meta_json"; return 1; }

  local vcpus memory
  vcpus=$(echo "$meta_json" | jq -r '.resources.vcpus')
  memory=$(echo "$meta_json" | jq -r '.resources.memory')

  # Delete pod if image changed (pods are immutable)
  local current_ref
  current_ref=$(running_image_ref "$name")
  if [ -n "$current_ref" ] && [ "$current_ref" != "$image_ref" ]; then
    log "[$name] image changed, replacing pod..."
    kubectl delete pod "seed-${name}" -n "$NAMESPACE" --grace-period=10 2>/dev/null || true
  fi

  # Generate and apply pod
  local pod_json
  pod_json=$(generate_pod "$name" "$image_ref" "$gen" "$vcpus" "$memory")

  # Storage: PVCs + volume mounts
  local storage_json
  storage_json=$(echo "$meta_json" | jq '.storage')
  local storage_keys
  storage_keys=$(echo "$storage_json" | jq -r 'keys[]')

  for key in $storage_keys; do
    local pvc_size
    pvc_size=$(echo "$storage_json" | jq -r --arg k "$key" '.[$k].size')
    local pvc_json
    pvc_json=$(generate_pvc "$name" "$key" "$pvc_size" "$gen")
    log "[$name] applying PVC: seed-${name}-${key}"
    echo "$pvc_json" | kubectl apply -f - 2>&1 | sed "s/^/  [$name] /"
  done

  pod_json=$(add_volumes_to_pod "$pod_json" "$name" "$storage_json")

  log "[$name] applying pod..."
  echo "$pod_json" | kubectl apply -f - 2>&1 | sed "s/^/  [$name] /"

  # Expose: service
  local expose_json
  expose_json=$(echo "$meta_json" | jq '.expose')
  local expose_keys
  expose_keys=$(echo "$expose_json" | jq -r 'keys[]')

  if [ -n "$expose_keys" ]; then
    local ports_array="[]"
    for key in $expose_keys; do
      local port
      port=$(echo "$expose_json" | jq -r --arg k "$key" '.[$k].port')

      ports_array=$(echo "$ports_array" | jq \
        --arg name "$key" \
        --argjson port "$port" \
        '. + [{ name: $name, port: $port, targetPort: $port, protocol: "TCP" }]')
    done

    local svc_json
    svc_json=$(generate_service "$name" "$gen" "$ports_array")
    log "[$name] applying service..."
    echo "$svc_json" | kubectl apply -f - 2>&1 | sed "s/^/  [$name] /"
  fi

  log "[$name] done (image=$image_ref)"
}

# Main reconciliation loop
main() {
  wait_for_k3s

  while true; do
    log "reconciliation starting..."

    # List all instance names from the flake
    local instances
    instances=$(nix eval "${FLAKE_PATH}#seeds.${SYSTEM}" --apply 'builtins.attrNames' --json 2>/dev/null \
      | jq -r '.[]') \
      || { log "failed to list instances"; sleep "$INTERVAL"; continue; }

    # Build all images first to compute generation hash
    local -A image_paths
    local hash_input=""
    local build_failed=0

    for name in $instances; do
      local path
      path=$(nix build "${FLAKE_PATH}#seeds.${SYSTEM}.${name}.image" --no-link --print-out-paths 2>&1) \
        || { log "[$name] build failed: $path"; (( build_failed++ )) || true; continue; }
      image_paths[$name]="$path"
      hash_input+="${name}=${path}"$'\n'
    done

    if [ "$build_failed" -gt 0 ]; then
      log "$build_failed instance(s) failed to build, skipping reconciliation"
      sleep "$INTERVAL"
      continue
    fi

    # Compute generation hash from sorted instance→storepath mapping
    local gen
    gen=$(echo -n "$hash_input" | sort | compute_generation)

    # Check if this generation is already deployed
    local deployed
    deployed=$(deployed_generation)
    if [ "$deployed" = "$gen" ]; then
      log "generation $gen already deployed, nothing to do"
      sleep "$INTERVAL"
      continue
    fi

    log "deploying generation $gen (was: ${deployed:-none})"

    local failed=0
    for name in $instances; do
      reconcile_instance "$name" "$gen" || (( failed++ )) || true
    done

    if [ "$failed" -eq 0 ]; then
      reap_old "$gen"
    else
      log "skipping reap — $failed instance(s) failed reconciliation"
    fi

    log "reconciliation complete (generation=$gen), sleeping ${INTERVAL}s"
    sleep "$INTERVAL"
  done
}

main "$@"
