// Manifest generation for seed-managed k8s resources.
// Pure functions: metadata in → k8s manifest objects out.

import type * as k8s from "@kubernetes/client-node";
import { seedLabels, LABELS, ANNOTATIONS } from "../shared/labels.js";
import type { SeedMeta, SeedHostTask, SeedHostTaskSpec } from "../shared/types.js";

/** Generate a Deployment manifest for a seed instance. */
export function generateDeployment(
  name: string,
  imageRef: string,
  generation: string,
  namespace: string,
  meta: SeedMeta,
  tpmSocketPath?: string,
): k8s.V1Deployment {
  const podAnnotations: Record<string, string> = {
    [ANNOTATIONS.KATA_VCPUS]: String(meta.resources.vcpus),
    [ANNOTATIONS.KATA_MEMORY]: String(meta.resources.memory),
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

  // TPM identity volume
  if (tpmSocketPath) {
    volumes.push({
      name: "tpm-identity",
      persistentVolumeClaim: { claimName: `seed-${name}-tpm-identity` },
    });
    mounts.push({
      name: "tpm-identity",
      mountPath: "/seed/tpm",
    });
  }

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: `seed-${name}`,
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
      name: `seed-${instance}`,
      namespace,
      labels: seedLabels(instance, generation),
    },
    spec: {
      selector: { "seed.loom.farm/instance": instance },
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
