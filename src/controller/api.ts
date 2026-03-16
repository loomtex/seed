// Internal management API for seed-shell.
//
// Endpoints:
//   GET  /api/keys                           — key→namespace index (for SSH auth)
//   GET  /api/ns/:namespace/status           — instance status overview
//   GET  /api/ns/:namespace/logs/:instance   — pod logs (last 100 lines)
//   POST /api/ns/:namespace/restart/:instance — restart an instance (delete pod)
//
// All responses are JSON. The shell authenticates users by SSH key, maps
// key→namespace via /api/keys, then proxies queries to the appropriate
// namespace endpoints.

import type { IncomingMessage, ServerResponse } from "node:http";
import type * as k8s from "@kubernetes/client-node";
import type { KubeClients } from "../shared/kube.js";
import { LABELS, MANAGED_SELECTOR } from "../shared/labels.js";
import { log } from "../shared/kube.js";

// --- Key index ---

export interface KeyIndex {
  // SSH public key (full line from .authorized_keys) → list of namespaces
  keys: Record<string, string[]>;
}

// Mutable key index, updated by the controller during reconciliation.
let keyIndex: KeyIndex = { keys: {} };

/** Update the global key index. Called by the controller after reconciliation. */
export function updateKeyIndex(index: KeyIndex): void {
  keyIndex = index;
  log("api", `key index updated: ${Object.keys(index.keys).length} keys`);
}

// --- Route handler ---

interface RouteContext {
  clients: KubeClients;
  kc: k8s.KubeConfig;
  // Namespace→flakePath mapping for validation
  validNamespaces: Set<string>;
}

let routeCtx: RouteContext | null = null;

/** Initialize the API route context. Called once at startup. */
export function initApi(
  clients: KubeClients,
  kc: k8s.KubeConfig,
  validNamespaces: Set<string>,
): void {
  routeCtx = { clients, kc, validNamespaces };
}

/** Update the set of valid namespaces (called when flakeStates change). */
export function updateValidNamespaces(namespaces: Set<string>): void {
  if (routeCtx) routeCtx.validNamespaces = namespaces;
}

/**
 * Try to handle an API request. Returns true if handled, false if not an API route.
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url || "";

  if (!url.startsWith("/api/")) return false;
  if (!routeCtx) {
    jsonResponse(res, 503, { error: "API not initialized" });
    return true;
  }

  try {
    // GET /api/keys
    if (req.method === "GET" && url === "/api/keys") {
      jsonResponse(res, 200, keyIndex);
      return true;
    }

    // Parse /api/ns/:namespace/...
    const nsMatch = url.match(/^\/api\/ns\/([a-z0-9-]+)\/(.+)$/);
    if (!nsMatch) {
      jsonResponse(res, 404, { error: "not found" });
      return true;
    }

    const [, namespace, rest] = nsMatch;

    // Validate namespace
    if (!routeCtx.validNamespaces.has(namespace)) {
      jsonResponse(res, 404, { error: "namespace not found" });
      return true;
    }

    // GET /api/ns/:namespace/status
    if (req.method === "GET" && rest === "status") {
      await handleStatus(res, routeCtx.clients, namespace);
      return true;
    }

    // GET /api/ns/:namespace/logs/:instance
    const logsMatch = rest.match(/^logs\/([a-z0-9-]+)$/);
    if (req.method === "GET" && logsMatch) {
      await handleLogs(res, routeCtx.clients, namespace, logsMatch[1]);
      return true;
    }

    // POST /api/ns/:namespace/restart/:instance
    const restartMatch = rest.match(/^restart\/([a-z0-9-]+)$/);
    if (req.method === "POST" && restartMatch) {
      await handleRestart(res, routeCtx.clients, namespace, restartMatch[1]);
      return true;
    }

    jsonResponse(res, 404, { error: "not found" });
  } catch (err) {
    log("api", `error handling ${req.method} ${url}: ${err}`);
    jsonResponse(res, 500, { error: "internal error" });
  }

  return true;
}

// --- Handlers ---

async function handleStatus(
  res: ServerResponse,
  clients: KubeClients,
  namespace: string,
): Promise<void> {
  const instances: Record<string, {
    ready: boolean;
    phase: string;
    restarts: number;
    age: string;
    image: string;
  }> = {};

  // List seed-managed deployments
  const deployments = await clients.apps.listNamespacedDeployment({
    namespace,
    labelSelector: MANAGED_SELECTOR,
  });

  for (const dep of deployments.items) {
    const instanceName = dep.metadata?.labels?.[LABELS.INSTANCE];
    if (!instanceName) continue;

    const ready = (dep.status?.readyReplicas ?? 0) > 0;
    const image = dep.spec?.template?.spec?.containers?.[0]?.image ?? "";

    // Get pod status for more detail
    const pods = await clients.core.listNamespacedPod({
      namespace,
      labelSelector: `${LABELS.INSTANCE}=${instanceName}`,
    });

    let phase = "Unknown";
    let restarts = 0;
    let age = "";

    if (pods.items.length > 0) {
      const pod = pods.items[0];
      phase = pod.status?.phase ?? "Unknown";
      const containerStatus = pod.status?.containerStatuses?.[0];
      restarts = containerStatus?.restartCount ?? 0;
      if (pod.metadata?.creationTimestamp) {
        age = relativeAge(new Date(pod.metadata.creationTimestamp));
      }
    } else {
      phase = "NoPod";
    }

    instances[instanceName] = { ready, phase, restarts, age, image };
  }

  jsonResponse(res, 200, { namespace, instances });
}

async function handleLogs(
  res: ServerResponse,
  clients: KubeClients,
  namespace: string,
  instance: string,
): Promise<void> {
  // Find the pod for this instance
  const pods = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `${LABELS.MANAGED_BY}=seed,${LABELS.INSTANCE}=${instance}`,
  });

  if (pods.items.length === 0) {
    jsonResponse(res, 404, { error: `no pod found for instance ${instance}` });
    return;
  }

  const podName = pods.items[0].metadata?.name;
  if (!podName) {
    jsonResponse(res, 500, { error: "pod has no name" });
    return;
  }

  try {
    const logResponse = await clients.core.readNamespacedPodLog({
      name: podName,
      namespace,
      tailLines: 100,
    });

    // readNamespacedPodLog returns raw log text as a string.
    // For Kata VMs with journal forwarding, each line is a JSON object.
    // Extract the MESSAGE field for human-readable output.
    const rawLines = (logResponse as string).split("\n").filter(Boolean);
    const lines = rawLines.map((line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.MESSAGE) {
          const unit = entry.UNIT || entry.SYSLOG_IDENTIFIER || "";
          return unit ? `${unit}: ${entry.MESSAGE}` : entry.MESSAGE;
        }
        return line;
      } catch {
        return line; // Not JSON, return as-is
      }
    });

    jsonResponse(res, 200, {
      instance,
      pod: podName,
      lines,
    });
  } catch (err) {
    log("api", `logs error for ${instance}/${podName}: ${err}`);
    jsonResponse(res, 200, {
      instance,
      pod: podName,
      lines: [],
      note: "Logs may be unavailable for Kata VM pods. Use service APIs for debugging.",
    });
  }
}

async function handleRestart(
  res: ServerResponse,
  clients: KubeClients,
  namespace: string,
  instance: string,
): Promise<void> {
  // Find the pod for this instance
  const pods = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `${LABELS.MANAGED_BY}=seed,${LABELS.INSTANCE}=${instance}`,
  });

  if (pods.items.length === 0) {
    jsonResponse(res, 404, { error: `no pod found for instance ${instance}` });
    return;
  }

  const podName = pods.items[0].metadata?.name;
  if (!podName) {
    jsonResponse(res, 500, { error: "pod has no name" });
    return;
  }

  // Delete the pod — the Deployment controller will recreate it
  await clients.core.deleteNamespacedPod({ name: podName, namespace });
  log("api", `restarted instance ${instance} (deleted pod ${podName})`, namespace);

  jsonResponse(res, 200, { instance, action: "restarted", pod: podName });
}

// --- Helpers ---

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
  });
  res.end(json);
}

function relativeAge(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
