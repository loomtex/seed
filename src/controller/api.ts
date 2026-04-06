// Internal management API for seed-shell.
//
// Endpoints:
//   GET  /api/keys                            — key→namespace index (for SSH auth)
//   GET  /api/ns/:namespace/status            — instance status overview
//   GET  /api/ns/:namespace/build-log          — nix builder pod logs
//   GET  /api/ns/:namespace/keys/:instance    — TPM age public key (for sops encryption)
//   GET  /api/ns/:namespace/logs/:instance    — pod logs (last 100 lines)
//   POST /api/ns/:namespace/restart/:instance — restart an instance (delete pod)
//
// All responses are JSON. The shell authenticates users by SSH key, maps
// key→namespace via /api/keys, then proxies queries to the appropriate
// namespace endpoints.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestOptions } from "node:https";
import type * as k8s from "@kubernetes/client-node";
import type { KubeClients } from "../shared/kube.js";
import { LABELS, MANAGED_SELECTOR } from "../shared/labels.js";
import { log } from "../shared/kube.js";

// --- Reconcile status (per-namespace) ---

export interface ReconcileStatus {
  phase: "idle" | "evaluating" | "building" | "applying" | "failed" | "complete";
  generation: string;         // current or last-applied generation hash (short)
  commit: string;             // deployed git rev (short hash, set on successful deploy)
  buildCommit: string;        // git rev being built (short hash, empty when idle/complete)
  startedAt: string;          // ISO timestamp
  finishedAt: string;         // ISO timestamp (empty if in progress)
  error: string;              // last error message (empty on success)
  instances: Record<string, InstanceBuildStatus>;
}

export interface InstanceBuildStatus {
  phase: "pending" | "building" | "done" | "error";
  error: string;
}

// Mutable reconcile status, keyed by namespace.
const reconcileStatuses = new Map<string, ReconcileStatus>();

/** Get reconcile status for a namespace. */
export function getReconcileStatus(namespace: string): ReconcileStatus | undefined {
  return reconcileStatuses.get(namespace);
}

/** Update reconcile status for a namespace. */
export function updateReconcileStatus(namespace: string, status: ReconcileStatus): void {
  reconcileStatuses.set(namespace, status);
}

// --- Key index ---

export interface NamespaceEntry {
  name: string;      // repo name (e.g. "seed", "shoot-demo")
  namespace: string; // k8s namespace (e.g. "s-gaydazldmnsg")
  identity: string;  // IPNS CID from .seed-identity (empty for legacy flakes)
}

export interface KeyIndex {
  // SSH public key (full line from .authorized_keys) → list of namespaces
  keys: Record<string, NamespaceEntry[]>;
}

// Mutable key index, updated by the controller during reconciliation.
let keyIndex: KeyIndex = { keys: {} };

/** Update the global key index. Called by the controller after reconciliation. */
export function updateKeyIndex(index: KeyIndex): void {
  keyIndex = index;
  log("api", `key index updated: ${Object.keys(index.keys).length} keys`);
}

// --- Plant handler ---

export type PlantHandler = (
  flakeUri: string,
  inviteCode: string,
  keyBlob: string,
  signature: string,
) => Promise<{ name: string; namespace: string; flakeUri: string; identity: string }>;

let plantHandler: PlantHandler | null = null;

/** Register the plant handler. Called by the controller after startup. */
export function setPlantHandler(handler: PlantHandler): void {
  plantHandler = handler;
}

// --- Replant handler ---

export type ReplantHandler = (
  identity: string,
  newFlakeUri: string,
  keyBlob: string,
) => Promise<{ name: string; namespace: string; flakeUri: string; identity: string }>;

let replantHandler: ReplantHandler | null = null;

/** Register the replant handler. Called by the controller after startup. */
export function setReplantHandler(handler: ReplantHandler): void {
  replantHandler = handler;
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
    // Strip query string for route matching, parse params separately
    const [pathname, queryString] = url.split("?", 2);
    const params = new URLSearchParams(queryString || "");

    // GET /api/keys
    if (req.method === "GET" && pathname === "/api/keys") {
      jsonResponse(res, 200, keyIndex);
      return true;
    }

    // POST /api/plant
    if (req.method === "POST" && pathname === "/api/plant") {
      await handlePlantRequest(req, res);
      return true;
    }

    // POST /api/replant
    if (req.method === "POST" && pathname === "/api/replant") {
      await handleReplantRequest(req, res);
      return true;
    }

    // Parse /api/ns/:namespace/...
    const nsMatch = pathname.match(/^\/api\/ns\/([a-z0-9-]+)\/(.+)$/);
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

    // GET /api/ns/:namespace/build-log?instance=NAME&lines=N
    if (req.method === "GET" && rest === "build-log") {
      const instance = params.get("instance") || "";
      const lines = Math.min(Math.max(parseInt(params.get("lines") || "200", 10) || 200, 1), 10000);
      await handleBuildLog(res, routeCtx.clients, namespace, instance, lines);
      return true;
    }

    // GET /api/ns/:namespace/keys/:instance — TPM age public key
    const keysMatch = rest.match(/^keys\/([a-z0-9-]+)$/);
    if (req.method === "GET" && keysMatch) {
      await handleKeys(res, namespace, keysMatch[1]);
      return true;
    }

    // GET /api/ns/:namespace/logs/:instance?lines=N&follow=true
    const logsMatch = rest.match(/^logs\/([a-z0-9-]+)$/);
    if (req.method === "GET" && logsMatch) {
      const lines = Math.min(Math.max(parseInt(params.get("lines") || "100", 10) || 100, 1), 10000);
      const follow = params.get("follow") === "true";
      await handleLogs(res, routeCtx.clients, routeCtx.kc, namespace, logsMatch[1], lines, follow);
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

async function handlePlantRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!plantHandler) {
    jsonResponse(res, 503, { error: "plant handler not initialized" });
    return;
  }

  // Read body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  let body: { flakeUri?: string; inviteCode?: string; keyBlob?: string; signature?: string };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    jsonResponse(res, 400, { error: "invalid JSON" });
    return;
  }

  const { flakeUri, inviteCode, keyBlob, signature } = body;
  if (!flakeUri || !inviteCode || !keyBlob) {
    jsonResponse(res, 400, { error: "missing required fields: flakeUri, inviteCode, keyBlob" });
    return;
  }

  try {
    const result = await plantHandler(flakeUri, inviteCode, keyBlob, signature || "");
    log("api", `planted ${result.flakeUri} → ${result.namespace}`);
    jsonResponse(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("api", `plant failed: ${msg}`);
    jsonResponse(res, 400, { error: msg });
  }
}

async function handleReplantRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!replantHandler) {
    jsonResponse(res, 503, { error: "replant handler not initialized" });
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  let body: { identity?: string; newFlakeUri?: string; keyBlob?: string };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    jsonResponse(res, 400, { error: "invalid JSON" });
    return;
  }

  const { identity, newFlakeUri, keyBlob } = body;
  if (!identity || !newFlakeUri || !keyBlob) {
    jsonResponse(res, 400, { error: "missing required fields: identity, newFlakeUri, keyBlob" });
    return;
  }

  try {
    const result = await replantHandler(identity, newFlakeUri, keyBlob);
    log("api", `replanted ${result.identity} → ${result.flakeUri}`);
    jsonResponse(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("api", `replant failed: ${msg}`);
    jsonResponse(res, 400, { error: msg });
  }
}

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

  const reconcile = reconcileStatuses.get(namespace) || null;
  jsonResponse(res, 200, { namespace, instances, reconcile });
}

async function handleBuildLog(
  res: ServerResponse,
  clients: KubeClients,
  namespace: string,
  instance: string,
  tailLines: number,
): Promise<void> {
  // Find builder pods — optionally filtered by instance
  const labelSelector = instance
    ? `seed.loom.farm/builder=true,${LABELS.INSTANCE}=${instance}`
    : "seed.loom.farm/builder=true";

  const pods = await clients.core.listNamespacedPod({ namespace, labelSelector });
  if (pods.items.length === 0) {
    // No live pods — try jobs (may have terminated)
    const jobs = await clients.batch.listNamespacedJob({ namespace });
    const builderJobs = jobs.items
      .filter((j) => j.metadata?.labels?.["seed.loom.farm/builder"] === "true")
      .filter((j) => !instance || j.metadata?.labels?.[LABELS.INSTANCE] === instance);

    if (builderJobs.length === 0) {
      jsonResponse(res, 404, { error: "no builder jobs found" });
      return;
    }

    // Get the most recent job's pod
    builderJobs.sort((a, b) =>
      new Date(b.metadata?.creationTimestamp ?? 0).getTime() - new Date(a.metadata?.creationTimestamp ?? 0).getTime(),
    );
    const jobName = builderJobs[0].metadata?.name;
    const jobPods = await clients.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    });

    if (jobPods.items.length === 0) {
      jsonResponse(res, 404, { error: `builder job ${jobName} has no pods (may have been cleaned up)` });
      return;
    }

    return returnPodLogs(res, clients, namespace, jobPods.items[0], tailLines);
  }

  // Sort pods by creation time descending, take the most recent
  pods.items.sort((a, b) =>
    new Date(b.metadata?.creationTimestamp ?? 0).getTime() - new Date(a.metadata?.creationTimestamp ?? 0).getTime(),
  );

  // Return logs from all builder pods (grouped by instance)
  const allLogs: { instance: string; pod: string; lines: string[] }[] = [];
  for (const pod of pods.items) {
    const inst = pod.metadata?.labels?.[LABELS.INSTANCE] || "unknown";
    const podName = pod.metadata?.name || "unknown";
    try {
      const logResponse = await clients.core.readNamespacedPodLog({
        name: podName,
        namespace,
        tailLines,
      });
      allLogs.push({ instance: inst, pod: podName, lines: (logResponse as string).split("\n").filter(Boolean) });
    } catch {
      allLogs.push({ instance: inst, pod: podName, lines: ["(logs unavailable)"] });
    }
  }

  jsonResponse(res, 200, { builds: allLogs });
}

async function returnPodLogs(
  res: ServerResponse,
  clients: KubeClients,
  namespace: string,
  pod: k8s.V1Pod,
  tailLines: number,
): Promise<void> {
  const podName = pod.metadata?.name || "unknown";
  const inst = pod.metadata?.labels?.[LABELS.INSTANCE] || "unknown";
  try {
    const logResponse = await clients.core.readNamespacedPodLog({
      name: podName,
      namespace,
      tailLines,
    });
    jsonResponse(res, 200, {
      builds: [{ instance: inst, pod: podName, lines: (logResponse as string).split("\n").filter(Boolean) }],
    });
  } catch {
    jsonResponse(res, 200, {
      builds: [{ instance: inst, pod: podName, lines: ["(logs unavailable — pod may have been cleaned up)"] }],
    });
  }
}

/** Parse a journal JSON line into a human-readable string. */
function parseLogLine(line: string): string {
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
}

async function handleLogs(
  res: ServerResponse,
  clients: KubeClients,
  kc: k8s.KubeConfig,
  namespace: string,
  instance: string,
  tailLines: number,
  follow: boolean,
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

  if (follow) {
    await handleLogFollow(res, kc, namespace, instance, podName, tailLines);
    return;
  }

  try {
    const logResponse = await clients.core.readNamespacedPodLog({
      name: podName,
      namespace,
      tailLines,
    });

    // readNamespacedPodLog returns raw log text as a string.
    // For Kata VMs with journal forwarding, each line is a JSON object.
    // Extract the MESSAGE field for human-readable output.
    const rawLines = (logResponse as string).split("\n").filter(Boolean);
    const lines = rawLines.map(parseLogLine);

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

/** Stream logs via chunked newline-delimited JSON (one line object per chunk). */
async function handleLogFollow(
  res: ServerResponse,
  kc: k8s.KubeConfig,
  namespace: string,
  instance: string,
  podName: string,
  tailLines: number,
): Promise<void> {
  // The @kubernetes/client-node readNamespacedPodLog doesn't support streaming.
  // Use the raw k8s API via https request for follow=true.
  const cluster = kc.getCurrentCluster();
  const user = kc.getCurrentUser();
  if (!cluster) {
    jsonResponse(res, 500, { error: "no cluster configured" });
    return;
  }

  const logUrl = `${cluster.server}/api/v1/namespaces/${namespace}/pods/${podName}/log?follow=true&tailLines=${tailLines}`;

  try {
    const https = await import("node:https");
    const { URL } = await import("node:url");

    const opts: RequestOptions = {};
    await kc.applyToHTTPSOptions(opts);
    const parsed = new URL(logUrl);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const k8sReq = https.request(
      {
        ...opts,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "GET",
        rejectUnauthorized: !cluster.skipTLSVerify,
      },
      (k8sRes) => {
        let buffer = "";
        k8sRes.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer
          for (const line of lines) {
            if (!line) continue;
            const msg = parseLogLine(line);
            res.write(`data: ${JSON.stringify({ line: msg })}\n\n`);
          }
        });
        k8sRes.on("end", () => {
          if (buffer) {
            const msg = parseLogLine(buffer);
            res.write(`data: ${JSON.stringify({ line: msg })}\n\n`);
          }
          res.end();
        });
        k8sRes.on("error", (err) => {
          log("api", `follow stream error for ${instance}/${podName}: ${err}`);
          res.end();
        });
      },
    );

    // If the client disconnects, abort the k8s request
    res.on("close", () => k8sReq.destroy());
    k8sReq.on("error", (err: Error) => {
      log("api", `follow request error for ${instance}/${podName}: ${err}`);
      if (!res.writableEnded) res.end();
    });
    k8sReq.end();
  } catch (err) {
    log("api", `follow setup error for ${instance}/${podName}: ${err}`);
    jsonResponse(res, 500, { error: "failed to start log stream" });
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

async function handleKeys(
  res: ServerResponse,
  namespace: string,
  instance: string,
): Promise<void> {
  const identityPath = `/var/lib/seed-controller/tpm/${namespace}-${instance}/age-identity`;
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(identityPath, "utf-8");
    const match = content.match(/^#\s*(?:public key|Recipient):\s*(\S+)/m);
    if (match) {
      jsonResponse(res, 200, { instance, publicKey: match[1] });
    } else {
      jsonResponse(res, 404, { error: "age identity exists but no public key found" });
    }
  } catch {
    jsonResponse(res, 404, { error: "no TPM identity provisioned yet (instance must boot once first)" });
  }
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
