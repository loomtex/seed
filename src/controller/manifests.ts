// Manifest generation for seed-managed k8s resources.
// Pure functions: metadata in → k8s manifest objects out.

import type * as k8s from "@kubernetes/client-node";
import { seedLabels, LABELS, MANAGED_BY_VALUE, ANNOTATIONS } from "../shared/labels.js";
import type { SeedMeta, SeedHostTask, SeedHostTaskSpec, SeedDNSRecord, SeedDNSRecordSpec, SeedDomain, SeedDomainSpec, CombineDomainConfig } from "../shared/types.js";

/** Generate a Deployment manifest for a seed instance. */
export function generateDeployment(
  name: string,
  imageRef: string,
  generation: string,
  namespace: string,
  meta: SeedMeta,
  tpmSocketPath?: string,
  poolManagerUrl?: string,
  acmeUrl?: string,
  estUrl?: string,
  instanceDomain?: string,
): k8s.V1Deployment {
  const podAnnotations: Record<string, string> = {
    [ANNOTATIONS.KATA_VCPUS]: String(meta.resources.vcpus),
    [ANNOTATIONS.KATA_MEMORY]: String(meta.resources.memory),
    [ANNOTATIONS.EXPOSE]: JSON.stringify(meta.expose),
  };
  if (tpmSocketPath) {
    podAnnotations[ANNOTATIONS.KATA_TPM_SOCKET] = tpmSocketPath;
  }

  // Readiness probe: TCP check on first exposed port for rolling rollouts
  const probePort = meta.rollout === "rolling"
    ? findProbePort(meta.expose)
    : undefined;

  const volumes: k8s.V1Volume[] = [];
  const mounts: k8s.V1VolumeMount[] = [];

  // Storage volumes
  for (const [key, entry] of Object.entries(meta.storage)) {
    volumes.push({
      name: key,
      persistentVolumeClaim: { claimName: `seed-${name}-${key}` },
    });
    mounts.push({
      name: key,
      mountPath: entry.mountPoint,
    });
  }

  // Platform CA trust — mount seed-ca ConfigMap (created by controller if cert-manager is available)
  volumes.push({
    name: "seed-ca",
    configMap: {
      name: "seed-ca",
      optional: true,
    },
  });
  mounts.push({
    name: "seed-ca",
    mountPath: "/etc/seed/ca",
    readOnly: true,
  });

  // TPM state volume (CephFS-backed hostPath)
  if (tpmSocketPath) {
    volumes.push({
      name: "tpm",
      hostPath: {
        path: `/var/lib/seed-controller/tpm/${namespace}-${name}`,
        type: "DirectoryOrCreate",
      },
    });
    mounts.push({
      name: "tpm",
      mountPath: "/seed/tpm",
    });
  }

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace,
      labels: seedLabels(name, generation),
    },
    spec: {
      replicas: 1,
      strategy: meta.rollout === "rolling"
        ? { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }
        : { type: "Recreate" },
      selector: {
        matchLabels: { [LABELS.INSTANCE]: name },
      },
      template: {
        metadata: {
          labels: {
            [LABELS.MANAGED_BY]: "seed",
            [LABELS.INSTANCE]: name,
          },
          annotations: podAnnotations,
        },
        spec: {
          runtimeClassName: "kata",
          terminationGracePeriodSeconds: 10,
          containers: [
            {
              name,
              image: imageRef,
              stdin: true,
              tty: true,
              securityContext: { privileged: true },
              env: [
                {
                  name: "SEED_NODE_IP",
                  valueFrom: { fieldRef: { fieldPath: "status.hostIP" } },
                },
                {
                  name: "SEED_NAMESPACE",
                  value: namespace,
                },
                {
                  name: "SEED_INSTANCE",
                  value: name,
                },
                ...(meta.shoot?.enable && poolManagerUrl ? [{
                  name: "SEED_SHOOT_URL",
                  value: poolManagerUrl,
                }] : []),
                ...(meta.acme && acmeUrl ? [
                  {
                    name: "SEED_ACME_URL",
                    value: acmeUrl,
                  },
                  {
                    name: "SEED_FQDN",
                    value: instanceDomain ? `${name}.${namespace}.${instanceDomain}` : `${name}.${namespace}.seed.loom.farm`,
                  },
                ] : []),
                ...(estUrl ? [{
                  name: "SEED_EST_URL",
                  value: estUrl,
                }] : []),
              ],
              ...(probePort ? {
                readinessProbe: {
                  tcpSocket: { port: probePort },
                  initialDelaySeconds: 1,
                  periodSeconds: 1,
                  failureThreshold: 30,
                },
              } : {}),
              ...(mounts.length > 0 ? { volumeMounts: mounts } : {}),
            },
          ],
          ...(volumes.length > 0 ? { volumes } : {}),
        },
      },
    },
  };
}

/** Generate a PVC manifest for instance storage. */
export function generatePVC(
  instance: string,
  key: string,
  size: string,
  generation: string,
  namespace: string,
): k8s.V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: `seed-${instance}-${key}`,
      namespace,
      labels: seedLabels(instance, generation),
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "ceph-rbd",
      resources: {
        requests: { storage: size },
      },
    },
  };
}

/** Generate a ClusterIP Service manifest for exposed ports. */
export function generateService(
  instance: string,
  generation: string,
  namespace: string,
  meta: SeedMeta,
): k8s.V1Service | null {
  const exposeKeys = Object.keys(meta.expose);
  if (exposeKeys.length === 0) return null;

  const ports = buildServicePorts(meta.expose);

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: instance,
      namespace,
      labels: seedLabels(instance, generation),
    },
    spec: {
      selector: { "seed.loom.farm/instance": instance },
      ports,
    },
  };
}

/** Generate an IPv6 LoadBalancer service for direct ingress to an instance.
 *  MetalLB auto-assigns an IPv6 from the pool. The controller reads the
 *  assigned IP from service status and registers a AAAA record in pdns. */
export function generateIngressService(
  instance: string,
  generation: string,
  namespace: string,
  meta: SeedMeta,
): k8s.V1Service | null {
  const ports = buildServicePorts(meta.expose);
  if (ports.length === 0) return null;

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: `${instance}-ingress`,
      namespace,
      labels: {
        ...seedLabels(instance, generation),
        [LABELS.SERVICE_TYPE]: "ingress",
      },
      annotations: {
        [ANNOTATIONS.ADDRESS_POOL]: "seed-pool",
      },
    },
    spec: {
      type: "LoadBalancer",
      ipFamilyPolicy: "SingleStack",
      ipFamilies: ["IPv6"],
      externalTrafficPolicy: "Local",
      selector: { [LABELS.INSTANCE]: instance },
      ports,
    },
  };
}

/** Generate a SeedHostTask CRD manifest. */
export function generateHostTask(
  instance: string,
  namespace: string,
  generation: string,
): SeedHostTask {
  return {
    apiVersion: "seed.loom.farm/v1alpha1",
    kind: "SeedHostTask",
    metadata: {
      name: `swtpm-${instance}`,
      namespace,
      labels: seedLabels(instance, generation),
    },
    spec: {
      type: "swtpm",
      instance,
      namespace,
    } satisfies SeedHostTaskSpec,
  };
}

/** Generate a SeedDNSRecord CRD manifest. */
export function generateDNSRecord(
  /** k8s resource name (sanitized, unique within namespace) */
  resourceName: string,
  namespace: string,
  generation: string,
  instance: string,
  spec: SeedDNSRecordSpec,
): SeedDNSRecord {
  return {
    apiVersion: "seed.loom.farm/v1alpha1",
    kind: "SeedDNSRecord",
    metadata: {
      name: resourceName,
      namespace,
      labels: seedLabels(instance, generation),
    },
    spec,
  };
}

/**
 * Resolve a DNS name against declared domains.
 * - If the name ends with a declared domain, it's already fully qualified
 * - Otherwise, append the default domain
 * Returns the resolved FQDN and the domain it belongs to (for domainRef).
 */
export function resolveDNSName(
  rawName: string,
  domains: Record<string, CombineDomainConfig>,
): { fqdn: string; domain: string } | null {
  const domainNames = Object.keys(domains);
  const defaultDomain = domainNames.find((d) => domains[d].default) || domainNames[0];

  if (!defaultDomain) return null;

  // Check if name already ends with a declared domain
  const normalizedName = rawName.endsWith(".") ? rawName.slice(0, -1) : rawName;
  for (const domain of domainNames) {
    if (normalizedName === domain || normalizedName.endsWith(`.${domain}`)) {
      return { fqdn: `${normalizedName}.`, domain };
    }
  }

  // Not fully qualified — append default domain
  const fqdn = `${normalizedName}.${defaultDomain}.`;
  return { fqdn, domain: defaultDomain };
}

/**
 * Generate all DNS records for an instance.
 * - Auto record: <instance>.<namespace>.<instanceDomain> via sourceRef
 * - Custom names from seed.dns.names via sourceRef (resolved against domains)
 * - Zone apex names automatically get a wildcard record
 *
 * CRDs are always generated — the DNS reconciler handles validation
 * (blacklisted domains get an error status, not synced to pdns).
 */
export function generateInstanceDNSRecords(
  instance: string,
  generation: string,
  namespace: string,
  meta: SeedMeta,
  instanceDomain: string,
  domains?: Record<string, CombineDomainConfig>,
): SeedDNSRecord[] {
  const records: SeedDNSRecord[] = [];
  const hasExpose = Object.keys(meta.expose).length > 0;
  if (!hasExpose) return records;

  const ingressServiceName = `${instance}-ingress`;

  // Auto AAAA record: <instance>.<namespace>.<instanceDomain>
  // No domainRef — platform zone is always ready (bootstrap)
  const autoFqdn = `${instance}.${namespace}.${instanceDomain}.`;
  records.push(generateDNSRecord(
    `dns-${instance}-auto`,
    namespace,
    generation,
    instance,
    {
      name: autoFqdn,
      type: "AAAA",
      ttl: 300,
      sourceRef: { kind: "Service", name: ingressServiceName },
    },
  ));

  // Custom DNS names from seed.dns.names
  const customNames = meta.dns?.names || [];
  for (const rawName of customNames) {
    // Resolve non-FQDN names against declared domains
    const resolved = domains
      ? resolveDNSName(rawName, domains)
      : { fqdn: rawName.endsWith(".") ? rawName : `${rawName}.`, domain: "" };

    if (!resolved) continue;

    const { fqdn, domain } = resolved;
    // Sanitize name for k8s resource name: replace dots and wildcards
    const safeName = fqdn.replace(/\.$/, "").replace(/\./g, "-").replace(/\*/g, "wildcard");

    // Build spec with optional domainRef (gate sync on zone readiness)
    const spec: SeedDNSRecordSpec = {
      name: fqdn,
      type: "AAAA",
      ttl: 300,
      sourceRef: { kind: "Service", name: ingressServiceName },
    };
    if (domain) {
      spec.domainRef = { name: domain };
    }

    records.push(generateDNSRecord(
      `dns-${instance}-${safeName}`,
      namespace,
      generation,
      instance,
      spec,
    ));

    // Zone apex → also generate wildcard
    const normalizedFqdn = fqdn.endsWith(".") ? fqdn.slice(0, -1) : fqdn;
    const isApex = !normalizedFqdn.startsWith("*.") && normalizedFqdn.split(".").length === 2;
    if (isApex) {
      const wildcardFqdn = `*.${fqdn}`;
      const wildcardSafeName = `wildcard-${safeName}`;

      const wildcardSpec: SeedDNSRecordSpec = {
        name: wildcardFqdn,
        type: "AAAA",
        ttl: 300,
        sourceRef: { kind: "Service", name: ingressServiceName },
      };
      if (domain) {
        wildcardSpec.domainRef = { name: domain };
      }

      records.push(generateDNSRecord(
        `dns-${instance}-${wildcardSafeName}`,
        namespace,
        generation,
        instance,
        wildcardSpec,
      ));
    }
  }

  return records;
}

/** Generate a SeedDomain CRD manifest from combine.domains config. */
export function generateDomainCRD(
  domainName: string,
  config: CombineDomainConfig,
  generation: string,
  namespace: string,
): SeedDomain {
  // Sanitize domain name for k8s resource name
  const resourceName = `domain-${domainName.replace(/\./g, "-")}`;
  return {
    apiVersion: "seed.loom.farm/v1alpha1",
    kind: "SeedDomain",
    metadata: {
      name: resourceName,
      namespace,
      labels: {
        [LABELS.MANAGED_BY]: MANAGED_BY_VALUE,
        [LABELS.GENERATION]: generation,
      },
    },
    spec: {
      name: domainName,
      register: config.register,
      ...(config.register ? { registrar: "namesilo" as const } : {}),
    },
  };
}

/** Find the first TCP-capable exposed port for readiness probing. */
export function findProbePort(
  expose: Record<string, { port: number; protocol: string }>,
): number | undefined {
  for (const entry of Object.values(expose)) {
    // tcp, http, grpc, dns all listen on TCP; skip udp-only
    if (entry.protocol !== "udp") return entry.port;
  }
  return undefined;
}

/** Build k8s service port entries from expose metadata. */
function buildServicePorts(
  expose: Record<string, { port: number; protocol: string }>,
): k8s.V1ServicePort[] {
  const ports: k8s.V1ServicePort[] = [];

  for (const [key, entry] of Object.entries(expose)) {
    switch (entry.protocol) {
      case "dns":
        ports.push(
          { name: `${key}-tcp`, port: entry.port, targetPort: entry.port, protocol: "TCP" },
          { name: `${key}-udp`, port: entry.port, targetPort: entry.port, protocol: "UDP" },
        );
        break;
      case "udp":
        ports.push(
          { name: key, port: entry.port, targetPort: entry.port, protocol: "UDP" },
        );
        break;
      default:
        // tcp, http, grpc — all TCP transport
        ports.push(
          { name: key, port: entry.port, targetPort: entry.port, protocol: "TCP" },
        );
        break;
    }
  }

  return ports;
}
