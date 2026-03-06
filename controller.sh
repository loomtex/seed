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
REFRESH_TRIGGER="${SEED_REFRESH_TRIGGER:-/var/lib/seed-controller/refresh}"
SWTPM_IMAGE="${SEED_SWTPM_IMAGE:-}"

LABEL_MANAGED="seed.loom.farm/managed-by=seed"

log() { echo "[seed] $(date -Iseconds) $*"; }
die() { log "FATAL: $*"; exit 1; }

# Derive a deterministic k8s-safe namespace from a flake URI
# Format: s-<12 chars of base32(sha256(uri))>
derive_namespace() {
  echo -n "$1" | sha256sum | cut -c1-20 \
    | basenc --base32 -w0 | tr '[:upper:]' '[:lower:]' | cut -c1-12 \
    | sed 's/^/s-/'
}

# Namespace: use override if set, otherwise derive from flake URI
if [ -n "${SEED_NAMESPACE:-}" ]; then
  NAMESPACE="$SEED_NAMESPACE"
else
  NAMESPACE=$(derive_namespace "$FLAKE_PATH")
fi

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
    -o jsonpath='{.items[0].metadata.labels.seed\.loom\.farm/generation}' 2>/dev/null || true
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
  local tpm_socket=${6:-}

  local pod
  pod=$(jq -n \
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
          "seed.loom.farm/managed-by": "seed",
          "seed.loom.farm/instance": $instance,
          "seed.loom.farm/generation": $gen
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
          tty: true,
          securityContext: {
            privileged: true
          }
        }]
      }
    }')

  # Add TPM socket annotation if swtpm is available
  if [ -n "$tpm_socket" ]; then
    pod=$(echo "$pod" | jq --arg sock "$tpm_socket" \
      '.metadata.annotations["io.katacontainers.config.hypervisor.tpm_socket"] = $sock')
  fi

  echo "$pod"
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
          "seed.loom.farm/managed-by": "seed",
          "seed.loom.farm/instance": $instance,
          "seed.loom.farm/generation": $gen
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
          "seed.loom.farm/managed-by": "seed",
          "seed.loom.farm/instance": $instance,
          "seed.loom.farm/generation": $gen
        }
      },
      spec: {
        selector: {
          "seed.loom.farm/instance": $instance
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

# Generate swtpm PVC manifest (persistent TPM state)
generate_tpm_pvc() {
  local instance=$1 gen=$2

  jq -n \
    --arg name "seed-${instance}-tpm" \
    --arg instance "$instance" \
    --arg gen "$gen" \
    '{
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: $name,
        namespace: "'"$NAMESPACE"'",
        labels: {
          "seed.loom.farm/managed-by": "seed",
          "seed.loom.farm/instance": $instance,
          "seed.loom.farm/generation": $gen,
          "seed.loom.farm/service-type": "tpm"
        }
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: "10Mi"
          }
        }
      }
    }'
}

# Generate swtpm pod manifest (runs on default runtime, not Kata)
generate_tpm_pod() {
  local instance=$1 gen=$2 image_ref=$3
  local socket_dir="/run/swtpm/${NAMESPACE}-${instance}"

  jq -n \
    --arg name "seed-${instance}-tpm" \
    --arg instance "$instance" \
    --arg gen "$gen" \
    --arg image "$image_ref" \
    --arg socket_dir "$socket_dir" \
    '{
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: $name,
        namespace: "'"$NAMESPACE"'",
        labels: {
          "seed.loom.farm/managed-by": "seed",
          "seed.loom.farm/instance": $instance,
          "seed.loom.farm/generation": $gen,
          "seed.loom.farm/service-type": "tpm"
        }
      },
      spec: {
        restartPolicy: "Always",
        terminationGracePeriodSeconds: 5,
        containers: [{
          name: "swtpm",
          image: $image,
          volumeMounts: [
            { name: "tpm-state", mountPath: "/tpm-state" },
            { name: "tpm-socket", mountPath: "/tpm-socket" }
          ]
        }],
        volumes: [
          {
            name: "tpm-state",
            persistentVolumeClaim: { claimName: ("seed-" + $instance + "-tpm") }
          },
          {
            name: "tpm-socket",
            hostPath: { path: $socket_dir, type: "DirectoryOrCreate" }
          }
        ]
      }
    }'
}

# Wait for a pod to be Ready (up to 60s)
wait_for_pod_ready() {
  local pod_name=$1
  local attempts=0
  until kubectl get pod "$pod_name" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running; do
    sleep 2
    (( attempts++ )) || true
    if [ "$attempts" -ge 30 ]; then
      log "[$pod_name] not ready after 60s"
      return 1
    fi
  done
  return 0
}

# Generate LoadBalancer service manifest for public ingress routes
# Args: instance gen lb_ip ports_json [service_type]
generate_lb_service() {
  local svc_name=$1 instance=$2 gen=$3 lb_ip=$4
  local ports_json=$5
  local svc_type=${6:-ipv4}

  local ip_family="IPv4"
  [ "$svc_type" = "ipv6" ] && ip_family="IPv6"

  jq -n \
    --arg name "$svc_name" \
    --arg instance "$instance" \
    --arg gen "$gen" \
    --arg lb_ip "$lb_ip" \
    --arg svc_type "$svc_type" \
    --arg ip_family "$ip_family" \
    --argjson ports "$ports_json" \
    '{
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: $name,
        namespace: "'"$NAMESPACE"'",
        labels: {
          "seed.loom.farm/managed-by": "seed",
          "seed.loom.farm/instance": $instance,
          "seed.loom.farm/generation": $gen,
          "seed.loom.farm/service-type": $svc_type
        },
        annotations: {
          "metallb.universe.tf/address-pool": "seed-pool"
        }
      },
      spec: {
        type: "LoadBalancer",
        loadBalancerIP: $lb_ip,
        ipFamilyPolicy: "SingleStack",
        ipFamilies: [$ip_family],
        externalTrafficPolicy: "Local",
        selector: {
          "seed.loom.farm/instance": $instance
        },
        ports: $ports
      }
    }'
}

# Reconcile ipv4 route block — creates LoadBalancer services for public ingress
reconcile_ipv4_routes() {
  local gen=$1
  local ipv4_address="${SEED_IPV4_ADDRESS:-}"

  # Check if ipv4 output exists and is enabled
  local ipv4_json
  ipv4_json=$(nix eval "${FLAKE_PATH}#ipv4" --json 2>/dev/null) || return 0
  local enabled
  enabled=$(echo "$ipv4_json" | jq -r '.enable // false')
  [ "$enabled" = "true" ] || return 0

  if [ -z "$ipv4_address" ]; then
    log "[ipv4] SEED_IPV4_ADDRESS not set, skipping route reconciliation"
    return 0
  fi

  log "[ipv4] reconciling routes (loadBalancerIP=$ipv4_address)"

  local routes_json
  routes_json=$(echo "$ipv4_json" | jq '.routes // {}')

  # Group routes by instance
  local instances_with_routes
  instances_with_routes=$(echo "$routes_json" | jq -r '[.[].instance] | unique | .[]')

  for instance in $instances_with_routes; do
    local ports_array="[]"

    # Get all route entries for this instance
    local route_keys
    route_keys=$(echo "$routes_json" | jq -r --arg inst "$instance" \
      'to_entries[] | select(.value.instance == $inst) | .key')

    for key in $route_keys; do
      local port target_port proto
      port=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].port')
      target_port=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].targetPort // .[$k].port')
      proto=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].protocol')

      case "$proto" in
        dns)
          ports_array=$(echo "$ports_array" | jq \
            --arg name "${key}-tcp" \
            --argjson port "$port" \
            --argjson tp "$target_port" \
            '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "TCP" }]')
          ports_array=$(echo "$ports_array" | jq \
            --arg name "${key}-udp" \
            --argjson port "$port" \
            --argjson tp "$target_port" \
            '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "UDP" }]')
          ;;
        udp)
          ports_array=$(echo "$ports_array" | jq \
            --arg name "$key" \
            --argjson port "$port" \
            --argjson tp "$target_port" \
            '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "UDP" }]')
          ;;
        *)
          ports_array=$(echo "$ports_array" | jq \
            --arg name "$key" \
            --argjson port "$port" \
            --argjson tp "$target_port" \
            '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "TCP" }]')
          ;;
      esac
    done

    local svc_json
    svc_json=$(generate_lb_service "seed-${instance}-ipv4" "$instance" "$gen" "$ipv4_address" "$ports_array")
    log "[ipv4] applying LoadBalancer service: seed-${instance}-ipv4"
    echo "$svc_json" | kubectl apply -f - 2>&1 | sed "s/^/  [ipv4] /"
  done
}

# Reconcile ipv6 route block — creates LoadBalancer services with addresses from reserved /64
reconcile_ipv6_routes() {
  local gen=$1
  local ipv6_block="${SEED_IPV6_BLOCK:-}"

  # Check if ipv6 output exists and is enabled
  local ipv6_json
  ipv6_json=$(nix eval "${FLAKE_PATH}#ipv6" --json 2>/dev/null) || return 0
  local enabled
  enabled=$(echo "$ipv6_json" | jq -r '.enable // false')
  [ "$enabled" = "true" ] || return 0

  if [ -z "$ipv6_block" ]; then
    log "[ipv6] SEED_IPV6_BLOCK not set, skipping route reconciliation"
    return 0
  fi

  # Strip prefix length to get the base address prefix
  local block_prefix
  block_prefix=$(echo "$ipv6_block" | sed 's|/[0-9]*$||; s/::$/::/')

  log "[ipv6] reconciling routes (block=$ipv6_block)"

  local routes_json
  routes_json=$(echo "$ipv6_json" | jq '.routes // {}')

  # Each route gets its own service (each has a unique address from the block)
  local route_keys
  route_keys=$(echo "$routes_json" | jq -r 'keys[]')

  for key in $route_keys; do
    local host port target_port proto instance
    host=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].host')
    port=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].port')
    target_port=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].targetPort // .[$k].port')
    proto=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].protocol')
    instance=$(echo "$routes_json" | jq -r --arg k "$key" '.[$k].instance')

    local lb_ip="${block_prefix}${host}"
    local ports_array="[]"

    case "$proto" in
      dns)
        ports_array=$(echo "$ports_array" | jq \
          --arg name "${key}-tcp" \
          --argjson port "$port" \
          --argjson tp "$target_port" \
          '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "TCP" }]')
        ports_array=$(echo "$ports_array" | jq \
          --arg name "${key}-udp" \
          --argjson port "$port" \
          --argjson tp "$target_port" \
          '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "UDP" }]')
        ;;
      udp)
        ports_array=$(echo "$ports_array" | jq \
          --arg name "$key" \
          --argjson port "$port" \
          --argjson tp "$target_port" \
          '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "UDP" }]')
        ;;
      *)
        ports_array=$(echo "$ports_array" | jq \
          --arg name "$key" \
          --argjson port "$port" \
          --argjson tp "$target_port" \
          '. + [{ name: $name, port: $port, targetPort: $tp, protocol: "TCP" }]')
        ;;
    esac

    local svc_name="seed-${key}-ipv6"
    local svc_json
    svc_json=$(generate_lb_service "$svc_name" "$instance" "$gen" "$lb_ip" "$ports_array" "ipv6")
    log "[ipv6] applying LoadBalancer service: $svc_name (addr=$lb_ip)"
    echo "$svc_json" | kubectl apply -f - 2>&1 | sed "s/^/  [ipv6] /"
  done
}

# Reap resources whose generation doesn't match current
reap_old() {
  local gen=$1

  local old_pods
  old_pods=$(kubectl get pods -n "$NAMESPACE" \
    -l "$LABEL_MANAGED" \
    -o json 2>/dev/null \
    | jq -r --arg gen "$gen" \
      '.items[] | select(.metadata.labels["seed.loom.farm/generation"] != $gen) | .metadata.name')

  for pod in $old_pods; do
    log "reaping pod: $pod"
    kubectl delete pod "$pod" -n "$NAMESPACE" --grace-period=10
  done

  local old_svcs
  old_svcs=$(kubectl get services -n "$NAMESPACE" \
    -l "$LABEL_MANAGED" \
    -o json 2>/dev/null \
    | jq -r --arg gen "$gen" \
      '.items[] | select(.metadata.labels["seed.loom.farm/generation"] != $gen) | .metadata.name')

  for svc in $old_svcs; do
    log "reaping service: $svc"
    kubectl delete service "$svc" -n "$NAMESPACE"
  done

  # PVCs are never reaped — delete manually if needed
}

# Reconcile a single instance using a pre-built image path.
reconcile_instance() {
  local name=$1 gen=$2 image_path=$3

  local image_ref="nix:0${image_path}"

  log "[$name] evaluating metadata..."
  local meta_json
  meta_json=$(nix eval "${FLAKE_PATH}#seeds.${name}.meta" --json 2>/dev/null) \
    || { log "[$name] eval failed"; return 1; }

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

  # swtpm: deploy vTPM pod if swtpm image is available
  local tpm_socket=""
  if [ -n "$SWTPM_IMAGE" ]; then
    local swtpm_image_ref="nix:0${SWTPM_IMAGE}"
    local socket_dir="/run/swtpm/${NAMESPACE}-${name}"
    tpm_socket="${socket_dir}/swtpm-sock"

    # Apply swtpm PVC (persistent TPM state — never reaped)
    local tpm_pvc_json
    tpm_pvc_json=$(generate_tpm_pvc "$name" "$gen")
    log "[$name] applying TPM PVC: seed-${name}-tpm"
    echo "$tpm_pvc_json" | kubectl apply -f - 2>&1 | sed "s/^/  [$name] /"

    # Apply swtpm pod
    local tpm_pod_json
    tpm_pod_json=$(generate_tpm_pod "$name" "$gen" "$swtpm_image_ref")

    # Delete existing tpm pod if image changed
    local current_tpm_ref
    current_tpm_ref=$(kubectl get pod "seed-${name}-tpm" -n "$NAMESPACE" \
      -o jsonpath='{.spec.containers[0].image}' 2>/dev/null || true)
    if [ -n "$current_tpm_ref" ] && [ "$current_tpm_ref" != "$swtpm_image_ref" ]; then
      log "[$name] swtpm image changed, replacing tpm pod..."
      kubectl delete pod "seed-${name}-tpm" -n "$NAMESPACE" --grace-period=5 2>/dev/null || true
    fi

    log "[$name] applying swtpm pod..."
    echo "$tpm_pod_json" | kubectl apply -f - 2>&1 | sed "s/^/  [$name] /"

    # Wait for swtpm pod to be running
    log "[$name] waiting for swtpm pod..."
    wait_for_pod_ready "seed-${name}-tpm" \
      || log "[$name] swtpm pod not ready, continuing without TPM"
  fi

  # Generate and apply pod
  local pod_json
  pod_json=$(generate_pod "$name" "$image_ref" "$gen" "$vcpus" "$memory" "$tpm_socket")

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

  # Add TPM identity volume to instance pod (persistent age key storage)
  if [ -n "$tpm_socket" ]; then
    local tpm_id_pvc_json
    tpm_id_pvc_json=$(generate_pvc "$name" "tpm-identity" "10Mi" "$gen")
    log "[$name] applying TPM identity PVC: seed-${name}-tpm-identity"
    echo "$tpm_id_pvc_json" | kubectl apply -f - 2>&1 | sed "s/^/  [$name] /"

    pod_json=$(echo "$pod_json" | jq '
      .spec.volumes = (.spec.volumes // []) + [{
        name: "tpm-identity",
        persistentVolumeClaim: { claimName: "seed-'"$name"'-tpm-identity" }
      }]
      | .spec.containers[0].volumeMounts = (.spec.containers[0].volumeMounts // []) + [{
        name: "tpm-identity",
        mountPath: "/seed/tpm"
      }]')
  fi

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
      local port proto
      port=$(echo "$expose_json" | jq -r --arg k "$key" '.[$k].port')
      proto=$(echo "$expose_json" | jq -r --arg k "$key" '.[$k].protocol')

      case "$proto" in
        dns)
          # DNS needs both TCP and UDP on the same port
          ports_array=$(echo "$ports_array" | jq \
            --arg name "${key}-tcp" \
            --argjson port "$port" \
            '. + [{ name: $name, port: $port, targetPort: $port, protocol: "TCP" }]')
          ports_array=$(echo "$ports_array" | jq \
            --arg name "${key}-udp" \
            --argjson port "$port" \
            '. + [{ name: $name, port: $port, targetPort: $port, protocol: "UDP" }]')
          ;;
        udp)
          ports_array=$(echo "$ports_array" | jq \
            --arg name "$key" \
            --argjson port "$port" \
            '. + [{ name: $name, port: $port, targetPort: $port, protocol: "UDP" }]')
          ;;
        *)
          # tcp, http, grpc — all TCP transport
          ports_array=$(echo "$ports_array" | jq \
            --arg name "$key" \
            --argjson port "$port" \
            '. + [{ name: $name, port: $port, targetPort: $port, protocol: "TCP" }]')
          ;;
      esac
    done

    local svc_json
    svc_json=$(generate_service "$name" "$gen" "$ports_array")
    log "[$name] applying service..."
    echo "$svc_json" | kubectl apply -f - 2>&1 | sed "s/^/  [$name] /"
  fi

  log "[$name] done (image=$image_ref)"
}

# Configure MetalLB address pools from SEED_IPV4_ADDRESS and SEED_IPV6_BLOCK
configure_metallb_pools() {
  local ipv4="${SEED_IPV4_ADDRESS:-}"
  local ipv6="${SEED_IPV6_BLOCK:-}"

  [ -n "$ipv4" ] || [ -n "$ipv6" ] || return 0

  # Wait for MetalLB CRDs and webhook to be available
  log "[metallb] waiting for CRDs and webhook..."
  local attempts=0
  until kubectl get crd ipaddresspools.metallb.io &>/dev/null \
    && kubectl get endpoints metallb-webhook-service -n metallb-system -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null | grep -q .; do
    sleep 5
    (( attempts++ )) || true
    if [ "$attempts" -ge 60 ]; then
      log "[metallb] not ready after 5 minutes, skipping pool config"
      return 1
    fi
  done

  # Build address list
  local addresses="[]"
  [ -n "$ipv4" ] && addresses=$(echo "$addresses" | jq --arg a "${ipv4}/32" '. + [$a]')
  [ -n "$ipv6" ] && addresses=$(echo "$addresses" | jq --arg a "$ipv6" '. + [$a]')

  log "[metallb] configuring address pool: $(echo "$addresses" | jq -c '.')"

  # Apply IPAddressPool
  jq -n --argjson addrs "$addresses" '{
    apiVersion: "metallb.io/v1beta1",
    kind: "IPAddressPool",
    metadata: {
      name: "seed-pool",
      namespace: "metallb-system"
    },
    spec: {
      addresses: $addrs,
      autoAssign: false
    }
  }' | kubectl apply -f - 2>&1 | sed 's/^/  [metallb] /'

  # Apply L2Advertisement
  jq -n '{
    apiVersion: "metallb.io/v1beta1",
    kind: "L2Advertisement",
    metadata: {
      name: "seed-l2",
      namespace: "metallb-system"
    },
    spec: {
      ipAddressPools: ["seed-pool"]
    }
  }' | kubectl apply -f - 2>&1 | sed 's/^/  [metallb] /'
}

# Main reconciliation loop
main() {
  wait_for_k3s

  log "using namespace: $NAMESPACE"
  kubectl get namespace "$NAMESPACE" &>/dev/null || \
    kubectl create namespace "$NAMESPACE"
  kubectl label namespace "$NAMESPACE" \
    "seed.loom.farm/managed-by=seed" --overwrite 2>/dev/null || true
  kubectl annotate namespace "$NAMESPACE" \
    "seed.loom.farm/flake-uri=$FLAKE_PATH" --overwrite 2>/dev/null || true

  # Configure MetalLB address pools (once at startup)
  configure_metallb_pools || true

  while true; do
    log "reconciliation starting..."

    # Check for refresh trigger (webhook / manual)
    local nix_refresh=""
    if [ -f "$REFRESH_TRIGGER" ]; then
      log "refresh trigger detected, bypassing nix cache"
      nix_refresh="--refresh"
      rm -f "$REFRESH_TRIGGER"
    fi

    # List all instance names from the flake
    local instances
    instances=$(nix eval "${FLAKE_PATH}#seeds" --apply builtins.attrNames --json $nix_refresh 2>/dev/null \
      | jq -r '.[]') \
      || { log "failed to list instances"; sleep "$INTERVAL"; continue; }

    # Build all images first to compute generation hash
    local -A image_paths
    local hash_input=""
    local build_failed=0

    for name in $instances; do
      log "[$name] building image..."
      local path
      path=$(nix build "${FLAKE_PATH}#seeds.${name}.image" --no-link --print-out-paths $nix_refresh 2>/dev/null) \
        || { log "[$name] build failed"; (( build_failed++ )) || true; continue; }
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

    # Reconcile public ingress routes on every loop (independent of instance generation)
    reconcile_ipv4_routes "$gen" || log "ipv4 route reconciliation failed"
    reconcile_ipv6_routes "$gen" || log "ipv6 route reconciliation failed"

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
      reconcile_instance "$name" "$gen" "${image_paths[$name]}" || (( failed++ )) || true
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
