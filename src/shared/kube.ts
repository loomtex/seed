// Kubernetes client setup and helpers.

import * as k8s from "@kubernetes/client-node";
import { createHash } from "node:crypto";

/** Load k8s config from cluster (in-pod) or default kubeconfig. */
export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return kc;
}

/** Create standard API clients from a KubeConfig. */
export function makeClients(kc: k8s.KubeConfig) {
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
    node: kc.makeApiClient(k8s.NodeV1Api),
  };
}

export type KubeClients = ReturnType<typeof makeClients>;

/**
 * Derive a deterministic k8s-safe namespace from a flake URI.
 * Format: s-<12 chars of base32(sha256(uri))>
 * Matches the bash implementation in controller.sh.
 */
export function deriveNamespace(flakeUri: string): string {
  const hash = createHash("sha256").update(flakeUri).digest("hex");
  // Take first 20 hex chars (matching `cut -c1-20`), then base32-encode the
  // ASCII text of those hex chars (matching bash `basenc --base32`), take 12.
  const hex20 = hash.slice(0, 20);
  const buf = Buffer.from(hex20); // ASCII text bytes, NOT hex-decoded binary
  const base32 = encodeBase32(buf).toLowerCase().slice(0, 12);
  return `s-${base32}`;
}

/** RFC 4648 base32 encoding (no padding). */
function encodeBase32(data: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

/**
 * Compute a generation hash from a sorted map of instance→storepath.
 * Returns the first 12 hex chars of sha256.
 */
export function computeGeneration(
  instances: Map<string, string>,
): string {
  const sorted = [...instances.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, path]) => `${name}=${path}`)
    .join("\n");
  const input = sorted + (sorted.length > 0 ? "\n" : "");
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Simple structured logger. */
export function log(
  component: string,
  message: string,
  context?: string,
): void {
  const ts = new Date().toISOString();
  const prefix = context ? `[${component}] [${context}]` : `[${component}]`;
  console.log(`${prefix} ${ts} ${message}`);
}

/**
 * Wait for a condition with polling.
 * Returns true if condition was met, false on timeout.
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(intervalMs);
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply a resource using create-or-update.
 */
export async function applyResource(
  core: k8s.CoreV1Api,
  kind: "Service" | "PersistentVolumeClaim" | "Namespace",
  namespace: string,
  manifest: k8s.V1Service | k8s.V1PersistentVolumeClaim | k8s.V1Namespace,
): Promise<void> {
  const name = manifest.metadata?.name;
  if (!name) throw new Error(`${kind} manifest missing metadata.name`);

  try {
    switch (kind) {
      case "Service":
        try {
          const existing = await core.readNamespacedService({ name, namespace });
          // Preserve clusterIP on update
          const svc = manifest as k8s.V1Service;
          if (existing.spec?.clusterIP) {
            svc.spec = svc.spec || {};
            svc.spec.clusterIP = existing.spec.clusterIP;
          }
          await core.replaceNamespacedService({ name, namespace, body: svc });
        } catch {
          await core.createNamespacedService({ namespace, body: manifest as k8s.V1Service });
        }
        break;
      case "PersistentVolumeClaim":
        try {
          await core.readNamespacedPersistentVolumeClaim({ name, namespace });
          // PVC exists — immutable, skip
          return;
        } catch {
          await core.createNamespacedPersistentVolumeClaim({
            namespace,
            body: manifest as k8s.V1PersistentVolumeClaim,
          });
        }
        break;
      case "Namespace":
        try {
          await core.readNamespace({ name });
        } catch {
          await core.createNamespace({ body: manifest as k8s.V1Namespace });
        }
        break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to apply ${kind} ${name}: ${msg}`);
  }
}

/**
 * Apply a Deployment — create if missing, update if spec changed.
 * k8s handles pod replacement via the Deployment controller.
 */
export async function applyDeployment(
  apps: k8s.AppsV1Api,
  namespace: string,
  deployment: k8s.V1Deployment,
): Promise<void> {
  const name = deployment.metadata?.name;
  if (!name) throw new Error("Deployment manifest missing metadata.name");

  try {
    const existing = await apps.readNamespacedDeployment({ name, namespace });
    // Clone to avoid mutating the desired state object with resourceVersion
    const body = structuredClone(deployment);
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await apps.replaceNamespacedDeployment({ name, namespace, body });
  } catch {
    // Clone to ensure no stale resourceVersion from a previous apply
    const body = structuredClone(deployment);
    delete body.metadata?.resourceVersion;
    await apps.createNamespacedDeployment({ namespace, body });
  }
}
