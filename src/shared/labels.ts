// Label constants and helpers for seed-managed k8s resources.
// All labels live under the seed.loom.farm domain.

export const LABEL_DOMAIN = "seed.loom.farm";

export const LABELS = {
  MANAGED_BY: `${LABEL_DOMAIN}/managed-by`,
  INSTANCE: `${LABEL_DOMAIN}/instance`,
  GENERATION: `${LABEL_DOMAIN}/generation`,
  SERVICE_TYPE: `${LABEL_DOMAIN}/service-type`,
} as const;

export const MANAGED_BY_VALUE = "seed";

export const ANNOTATIONS = {
  FLAKE_URI: `${LABEL_DOMAIN}/flake-uri`,
  COMMIT: `${LABEL_DOMAIN}/commit`,
  ADDRESS_POOL: "metallb.io/address-pool",
  ALLOW_SHARED_IP: "metallb.io/allow-shared-ip",
  KATA_VCPUS: "io.katacontainers.config.hypervisor.default_vcpus",
  KATA_MEMORY: "io.katacontainers.config.hypervisor.default_memory",
  KATA_TPM_SOCKET: "io.katacontainers.config.hypervisor.tpm_socket",
} as const;

/** Build the standard seed label set for a resource. */
export function seedLabels(
  instance: string,
  generation: string,
): Record<string, string> {
  return {
    [LABELS.MANAGED_BY]: MANAGED_BY_VALUE,
    [LABELS.INSTANCE]: instance,
    [LABELS.GENERATION]: generation,
  };
}

/** Label selector string for kubectl-style queries. */
export const MANAGED_SELECTOR = `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`;
