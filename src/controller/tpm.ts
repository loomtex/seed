// Shim-owned swtpm: SeedTPM records and the create → verify flip.
//
// See src/shared/tpm.ts for the pod annotation contract. This module owns
// the cluster side:
//   - reading SeedTPM records before rendering (mode = create | verify);
//   - recording the fingerprint the shim wrote after a create-mode boot;
//   - re-rendering that instance's Deployment in verify mode (rolls it once).

import * as k8s from "@kubernetes/client-node";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type KubeClients, log, getOrNull, withApiRetry,
  applyDeployment, recordEvent,
} from "../shared/kube.js";
import { ANNOTATIONS, LABELS, MANAGED_SELECTOR } from "../shared/labels.js";
import type { DesiredState, SeedTPM, SeedTPMCondition, SeedTPMStatus, ShimTpmMode } from "../shared/types.js";
import {
  FINGERPRINT_FILE, SENTINEL_FILE, TPM_STATE_BASE, decideTpmFlip, isValidFingerprint, tpmStateDir,
  type ShimTpmRenderContext, type TpmFlipDecision,
} from "../shared/tpm.js";
import { applyShimTpm, generateSeedTPM } from "./manifests.js";

const GROUP = "seed.loom.farm";
const VERSION = "v1alpha1";
const PLURAL = "seedtpms";
const COMPONENT = "tpm";

export const CONDITION_FINGERPRINT_MISMATCH = "FingerprintMismatch";

// --- SeedTPM reads/writes ---

/**
 * Recorded fingerprints by instance name. Errors propagate (after retries):
 * silently treating a failed read as "no records" would re-render recorded
 * instances in create mode. A 404 means the CRD isn't installed yet, so
 * nothing can have been recorded.
 */
export async function readSeedTPMRecords(
  clients: KubeClients,
  namespace: string,
): Promise<Map<string, string>> {
  const records = new Map<string, string>();
  const list = await withApiRetry(`list SeedTPMs in ${namespace}`, () =>
    getOrNull(() => clients.custom.listNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace, plural: PLURAL,
    }) as Promise<{ items: SeedTPM[] }>));
  for (const tpm of list?.items ?? []) {
    const name = tpm.metadata?.name;
    const fp = tpm.status?.fingerprint;
    if (!name) continue;
    if (isValidFingerprint(fp)) records.set(name, fp);
    else if (fp) log(COMPONENT, `SeedTPM ${namespace}/${name} has a malformed fingerprint, ignoring: ${JSON.stringify(fp)}`);
  }
  return records;
}

/** Expected Ceph fsid for TPM_STATE_BASE, from seed.tpm.expectedFsid ("" = not configured). */
export function expectedTpmFsid(): string {
  return (process.env["SEED_TPM_EXPECTED_FSID"] ?? "").trim();
}

/**
 * Throw unless TPM_STATE_BASE is the expected CephFS: its sentinel file must
 * hold the expected fsid. The mountpoint directory exists on every node, so
 * an unmounted CephFS looks like an empty state tree; without this check the
 * controller would read "no TPM state" and could render create mode over a
 * live TPM. Same check the Kata shim makes before starting swtpm.
 */
export async function assertTpmStorage(expectedFsid = expectedTpmFsid(), base = TPM_STATE_BASE): Promise<void> {
  if (!expectedFsid) throw new Error("TPM storage check: SEED_TPM_EXPECTED_FSID is not configured (seed.tpm.expectedFsid)");
  const path = join(base, SENTINEL_FILE);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(`TPM storage check: cannot read ${path} (CephFS not mounted?): ${err}`);
  }
  if (content.trim() !== expectedFsid) {
    throw new Error(`TPM storage check: ${path} holds ${JSON.stringify(content.trim())}, expected ${expectedFsid}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * True if the state dir holds a TPM the shim didn't create: tpm2-00.permall
 * exists but tpm-fingerprint doesn't (host-agent-era state). A shim-created
 * TPM whose fingerprint isn't recorded yet has both files and can be
 * rendered in create mode so the flip controller records it.
 */
export async function legacyStateExists(stateDir: string): Promise<boolean> {
  return await exists(join(stateDir, "tpm2-00.permall")) &&
    !await exists(join(stateDir, FINGERPRINT_FILE));
}

/**
 * Load what renderDesiredState needs for instance TPMs in one namespace.
 * An instance with host-agent-era TPM state and no SeedTPM record can't be
 * rendered: create mode would ask the shim to create a TPM over a live one,
 * and there is no legacy path left. That fails the reconcile (leaving the
 * running Deployments alone) until tpm-backfill records it.
 */
export async function loadShimTpmContext(
  clients: KubeClients,
  namespace: string,
  instanceNames: Iterable<string>,
  hasLegacyState: (stateDir: string) => Promise<boolean> = legacyStateExists,
  checkStorage: () => Promise<void> = assertTpmStorage,
): Promise<ShimTpmRenderContext> {
  const names = [...instanceNames];
  if (names.length === 0) return { records: new Map() };
  // Create vs verify and the backfill guard both read the state tree: refuse
  // to decide anything (fail this reconcile) unless it's really CephFS.
  await checkStorage();
  const records = await readSeedTPMRecords(clients, namespace);
  const unbackfilled: string[] = [];
  for (const name of names) {
    if (!records.has(name) && await hasLegacyState(tpmStateDir(namespace, name))) unbackfilled.push(name);
  }
  if (unbackfilled.length > 0) {
    throw new Error(
      `TPM state without a SeedTPM record for ${unbackfilled.map((n) => `${namespace}/${n}`).join(", ")}: ` +
      `run tpm-backfill --write-status first (refusing to render create mode over an existing TPM)`);
  }
  return { records };
}

async function getSeedTPM(clients: KubeClients, namespace: string, name: string): Promise<SeedTPM | null> {
  return getOrNull(() => clients.custom.getNamespacedCustomObject({
    group: GROUP, version: VERSION, namespace, plural: PLURAL, name,
  }) as Promise<SeedTPM>);
}

async function ensureSeedTPM(clients: KubeClients, namespace: string, name: string): Promise<SeedTPM> {
  const existing = await getSeedTPM(clients, namespace, name);
  if (existing) return existing;
  return await clients.custom.createNamespacedCustomObject({
    group: GROUP, version: VERSION, namespace, plural: PLURAL,
    body: generateSeedTPM(name, namespace),
  }) as SeedTPM;
}

export type RecordResult =
  | { result: "recorded" }
  | { result: "already-recorded" }
  | { result: "conflict"; existing: string };

/**
 * Record an instance's TPM fingerprint in its SeedTPM (creating the object if
 * needed). Never replaces a different recorded fingerprint — returns
 * "conflict" instead (the CRD's transition rule also rejects it server-side).
 */
export async function recordSeedTPMFingerprint(
  clients: KubeClients,
  namespace: string,
  name: string,
  fingerprint: string,
  createdAt: string,
  source: "shim" | "backfill",
): Promise<RecordResult> {
  if (!isValidFingerprint(fingerprint)) throw new Error(`refusing to record malformed fingerprint ${JSON.stringify(fingerprint)}`);
  return withApiRetry(`record SeedTPM ${namespace}/${name}`, async () => {
    const tpm = await ensureSeedTPM(clients, namespace, name);
    const existing = tpm.status?.fingerprint;
    if (existing === fingerprint) return { result: "already-recorded" } as const;
    if (existing) return { result: "conflict", existing } as const;
    const status: SeedTPMStatus = {
      ...tpm.status,
      fingerprint,
      createdAt,
      stateDir: tpmStateDir(namespace, name),
      source,
    };
    await clients.custom.replaceNamespacedCustomObjectStatus({
      group: GROUP, version: VERSION, namespace, plural: PLURAL, name,
      body: { ...tpm, status },
    });
    return { result: "recorded" } as const;
  });
}

/** Set (or clear) the FingerprintMismatch condition, leaving the record alone. */
async function setMismatchCondition(
  clients: KubeClients,
  namespace: string,
  name: string,
  mismatch: { file: string } | null,
): Promise<void> {
  await withApiRetry(`SeedTPM ${namespace}/${name} condition`, async () => {
    const tpm = await getSeedTPM(clients, namespace, name);
    if (!tpm?.status?.fingerprint) return;
    const conditions = tpm.status.conditions ?? [];
    const current = conditions.find((c) => c.type === CONDITION_FINGERPRINT_MISMATCH);
    const want: SeedTPMCondition = mismatch
      ? {
        type: CONDITION_FINGERPRINT_MISMATCH,
        status: "True",
        reason: "FileDiffersFromRecord",
        message: `${FINGERPRINT_FILE} contains ${mismatch.file}, recorded ${tpm.status.fingerprint}. ` +
          `The record is not changed automatically; investigate whether the TPM state was replaced.`,
        lastTransitionTime: new Date().toISOString(),
      }
      : {
        type: CONDITION_FINGERPRINT_MISMATCH,
        status: "False",
        reason: "FileMatchesRecord",
        message: "",
        lastTransitionTime: new Date().toISOString(),
      };
    if (!mismatch && (!current || current.status === "False")) return;
    if (mismatch && current?.status === "True" && current.message === want.message) return;
    const status: SeedTPMStatus = {
      ...tpm.status,
      conditions: [...conditions.filter((c) => c.type !== CONDITION_FINGERPRINT_MISMATCH), want],
    };
    await clients.custom.replaceNamespacedCustomObjectStatus({
      group: GROUP, version: VERSION, namespace, plural: PLURAL, name,
      body: { ...tpm, status },
    });
  });
}

// --- Create → verify flip ---

/** What the flip controller needs from the reconciler's per-flake state. */
export interface FlipStateAccess {
  /** Namespaces currently managed. */
  namespaces(): string[];
  /** Desired state for a namespace (null if unknown / not rendered yet). */
  desired(namespace: string): DesiredState | null;
  /** True while a full reconcile of that namespace is in progress. */
  reconciling(namespace: string): boolean;
}

export interface FlipControllerOptions {
  kc: k8s.KubeConfig;
  clients: KubeClients;
  state: FlipStateAccess;
  sweepIntervalMs?: number;
  /** Override for tests. */
  readFingerprintFile?: (stateDir: string) => Promise<{ content: string; mtimeMs: number } | null>;
  /** Override for tests (default: assertTpmStorage). */
  checkStorage?: () => Promise<void>;
}

/** Read <state-dir>/tpm-fingerprint via the controller's read-only mount. */
export async function readFingerprintFile(
  stateDir: string,
): Promise<{ content: string; mtimeMs: number } | null> {
  const path = join(stateDir, FINGERPRINT_FILE);
  try {
    const st = await stat(path);
    if (!st.isFile()) return { content: "", mtimeMs: st.mtimeMs };
    if (st.size > 1024) return { content: `<${st.size} bytes>`, mtimeMs: st.mtimeMs };
    return { content: await readFile(path, "utf-8"), mtimeMs: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function podIsReady(pod: k8s.V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return false;
  return pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
}

function podTpmMode(pod: k8s.V1Pod): "create" | "verify" | null {
  const mode = pod.metadata?.annotations?.[ANNOTATIONS.TPM_MODE];
  return mode === "create" || mode === "verify" ? mode : null;
}

/**
 * Pick the pod that represents the instance right now: prefer a live
 * create-mode pod (the only kind that can produce a record), then any live
 * pod, newest first.
 */
export function currentInstancePod(pods: k8s.V1Pod[]): k8s.V1Pod | null {
  // creationTimestamp is a Date after deserialization (a string in raw JSON)
  const created = (p: k8s.V1Pod) => {
    const t = p.metadata?.creationTimestamp;
    return t ? new Date(t).getTime() : 0;
  };
  const live = pods
    .filter((p) => !p.metadata?.deletionTimestamp && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed")
    .sort((a, b) => created(b) - created(a));
  return live.find((p) => podTpmMode(p) === "create") ?? live[0] ?? null;
}

/**
 * Start the flip controller: a pod informer (fast path, fires when a
 * create-mode pod turns Ready) plus a periodic sweep over all opted-in
 * instances (catches the fingerprint file landing after Ready, retries after
 * errors or a concurrent reconcile, and re-checks for mismatches).
 */
export function startTpmFlipController(opts: FlipControllerOptions): void {
  const { kc, clients, state } = opts;
  const readFp = opts.readFingerprintFile ?? readFingerprintFile;
  const checkStorage = opts.checkStorage ?? (() => assertTpmStorage());
  const inFlight = new Set<string>();
  const warned = new Map<string, string>(); // key → last warning (dedupe log + events)

  const podInformer = k8s.makeInformer<k8s.V1Pod>(
    kc,
    "/api/v1/pods",
    () => clients.core.listPodForAllNamespaces({ labelSelector: MANAGED_SELECTOR }) as Promise<k8s.KubernetesListObject<k8s.V1Pod>>,
    MANAGED_SELECTOR,
  );

  function podsFor(namespace: string, instance: string): k8s.V1Pod[] {
    return podInformer.list(namespace).filter((p) => p.metadata?.labels?.[LABELS.INSTANCE] === instance);
  }

  function warnOnce(key: string, msg: string): boolean {
    if (warned.get(key) === msg) return false;
    warned.set(key, msg);
    log(COMPONENT, `WARNING: ${msg}`, key);
    return true;
  }

  async function event(namespace: string, name: string, type: "Normal" | "Warning", reason: string, message: string) {
    await recordEvent(clients.core, { apiVersion: `${GROUP}/${VERSION}`, kind: "SeedTPM", name, namespace }, type, reason, message);
  }

  /** Rewrite the desired Deployment in verify mode and apply it. */
  async function flipToVerify(namespace: string, name: string, fingerprint: string): Promise<void> {
    if (state.reconciling(namespace)) {
      log(COMPONENT, `reconcile in progress, deferring verify-mode flip to next sweep`, name);
      return;
    }
    const desired = state.desired(namespace);
    const instance = desired?.instances.get(name);
    if (!desired || !instance?.shimTpm) return;
    const verify: ShimTpmMode = { mode: "verify", fingerprint };
    instance.deployment = applyShimTpm(instance.deployment, namespace, name, verify);
    instance.shimTpm = verify;
    await withApiRetry(`deployment ${namespace}/${name} (verify mode)`, () =>
      applyDeployment(clients.apps, namespace, instance.deployment));
    log(COMPONENT, `re-rendered deployment in verify mode (fingerprint ${fingerprint})`, `${namespace}/${name}`);
  }

  async function act(namespace: string, name: string, decision: TpmFlipDecision): Promise<void> {
    const key = `${namespace}/${name}`;
    switch (decision.action) {
      case "none":
      case "wait":
        return;
      case "record": {
        const res = await recordSeedTPMFingerprint(
          clients, namespace, name, decision.fingerprint,
          new Date(decision.createdAtMs).toISOString(), "shim");
        if (res.result === "conflict") {
          // Raced with another writer (e.g. backfill): treat as a mismatch.
          await act(namespace, name, { action: "mismatch", recorded: res.existing, file: decision.fingerprint });
          return;
        }
        if (res.result === "recorded") {
          log(COMPONENT, `recorded TPM fingerprint ${decision.fingerprint}`, key);
          await event(namespace, name, "Normal", "FingerprintRecorded",
            `Recorded TPM fingerprint ${decision.fingerprint} after create-mode boot`);
        }
        await flipToVerify(namespace, name, decision.fingerprint);
        return;
      }
      case "apply-verify":
        await flipToVerify(namespace, name, decision.fingerprint);
        return;
      case "mismatch": {
        const msg = `TPM FINGERPRINT MISMATCH: ${FINGERPRINT_FILE} says ${decision.file} but SeedTPM records ` +
          `${decision.recorded}. The TPM state may have been replaced. Record NOT changed; ` +
          `delete the SeedTPM only if re-creating this TPM is intended.`;
        if (warnOnce(key, msg)) await event(namespace, name, "Warning", "FingerprintMismatch", msg);
        await setMismatchCondition(clients, namespace, name, { file: decision.file });
        return;
      }
      case "invalid-file": {
        const msg = `not recording TPM fingerprint: ${decision.reason}`;
        if (warnOnce(key, msg)) await event(namespace, name, "Warning", "FingerprintFileInvalid", msg);
        return;
      }
    }
  }

  async function check(namespace: string, name: string): Promise<void> {
    const key = `${namespace}/${name}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const instance = state.desired(namespace)?.instances.get(name);
      if (!instance?.shimTpm) return;

      const tpm = await withApiRetry(`get SeedTPM ${key}`, () => getSeedTPM(clients, namespace, name));
      const recorded = isValidFingerprint(tpm?.status?.fingerprint) ? tpm!.status!.fingerprint : null;
      const pod = currentInstancePod(podsFor(namespace, name));
      await checkStorage(); // never record a fingerprint read off the wrong filesystem
      const file = await readFp(tpmStateDir(namespace, name));
      const startTime = pod?.status?.startTime ? new Date(pod.status.startTime).getTime() : null;

      const decision = decideTpmFlip({
        recorded,
        podMode: pod ? podTpmMode(pod) : null,
        podReady: pod ? podIsReady(pod) : false,
        podStartedAtMs: startTime,
        file,
      });
      await act(namespace, name, decision);

      // Clear a stale mismatch condition once file and record agree again.
      if (recorded && decision.action !== "mismatch" && tpm?.status?.conditions?.some(
        (c) => c.type === CONDITION_FINGERPRINT_MISMATCH && c.status === "True")) {
        await setMismatchCondition(clients, namespace, name, null);
        warned.delete(key);
      }
    } catch (err) {
      log(COMPONENT, `flip check failed (will retry on next sweep): ${err}`, key);
    } finally {
      inFlight.delete(key);
    }
  }

  function onPod(pod: k8s.V1Pod): void {
    const ns = pod.metadata?.namespace;
    const name = pod.metadata?.labels?.[LABELS.INSTANCE];
    if (!ns || !name || podTpmMode(pod) !== "create") return;
    if (!podIsReady(pod)) return;
    void check(ns, name);
  }

  async function sweep(): Promise<void> {
    for (const ns of state.namespaces()) {
      const desired = state.desired(ns);
      if (!desired) continue;
      for (const [name, instance] of desired.instances) {
        if (instance.shimTpm) await check(ns, name);
      }
    }
  }

  podInformer.on("add", onPod);
  podInformer.on("update", onPod);
  podInformer.on("error", (err) => {
    // Informers stop on a watch error; restart so podsFor() doesn't read a stale cache.
    log(COMPONENT, `pod informer error, restarting in 5s: ${err}`);
    setTimeout(() => podInformer.start(), 5_000);
  });
  void podInformer.start().then(
    () => log(COMPONENT, "watching managed pods for create-mode TPM boots"),
    (err) => log(COMPONENT, `pod informer failed to start: ${err}`),
  );

  const interval = opts.sweepIntervalMs ?? 30_000;
  const timer = setInterval(() => { void sweep(); }, interval);
  timer.unref();
  void sweep();
}

