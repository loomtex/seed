// Upgrade agent — pure decision logic (no I/O). The side-effecting flow in
// upgrade.ts is a thin shell around these, so they carry the unit tests.

import type * as k8s from "@kubernetes/client-node";
import { LABEL_DOMAIN } from "../shared/labels.js";
import { CONTROL_PLANE_LABEL } from "./upgrade-schedule.js";

export const LEASE_NAME = "node-upgrade";
export const LEASE_NAMESPACE = "seed-system";
export const LEASE_DURATION_SECONDS = 1800;
/** A node heartbeat older than this fails the pre-check / health gate. */
export const HEARTBEAT_MAX_AGE_MS = 120_000;
/** Reboot re-issues allowed when the boot ID didn't change (then hold). */
export const MAX_REBOOT_ATTEMPTS = 2;

export const UPGRADE_ANNOTATIONS = {
  /** Lease: upgrading | rebooting | held */
  PHASE: `${LABEL_DOMAIN}/upgrade-phase`,
  /** Lease: bootID of the holder when it issued the reboot */
  BOOT_ID: `${LABEL_DOMAIN}/upgrade-boot-id`,
  /** Lease: reboots issued for this upgrade (re-issue at most once) */
  REBOOT_ATTEMPTS: `${LABEL_DOMAIN}/upgrade-reboot-attempts`,
  /** Lease: ISO time phase=upgrading was entered (validates the state file) */
  STARTED: `${LABEL_DOMAIN}/upgrade-started`,
  /** Lease: why the holder is holding (phase=held) */
  HOLD_REASON: `${LABEL_DOMAIN}/upgrade-hold-reason`,
  /** Node: set by the agent iff it did the cordon (so it may uncordon) */
  CORDONED: `${LABEL_DOMAIN}/upgrade-cordoned`,
  /** Node: "true" = run the upgrade flow once, now (still Lease-gated) */
  UPGRADE_NOW: `${LABEL_DOMAIN}/upgrade-now`,
  /** Node: "true" with upgrade-now = reboot this time even if the kernel didn't change */
  UPGRADE_REBOOT: `${LABEL_DOMAIN}/upgrade-reboot`,
} as const;

export type Phase = "upgrading" | "rebooting" | "held";
export type Mode = "dry-run" | "active";

export function parseMode(v: string | undefined): Mode {
  return v === "active" ? "active" : "dry-run";
}

// --- Lease ---

/** client-node hands MicroTime back as a raw string; accept both. */
export function toMs(t: Date | string | undefined | null): number | undefined {
  if (t === undefined || t === null) return undefined;
  const ms = new Date(t as string).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export function leaseHolder(lease: k8s.V1Lease | null): string {
  return lease?.spec?.holderIdentity ?? "";
}

/** renewTime (or acquireTime) + leaseDurationSeconds < now. No time = expired. */
export function leaseExpired(lease: k8s.V1Lease, nowMs: number): boolean {
  const spec = lease.spec ?? {};
  const last = toMs(spec.renewTime) ?? toMs(spec.acquireTime);
  if (last === undefined) return true;
  const duration = (spec.leaseDurationSeconds ?? LEASE_DURATION_SECONDS) * 1000;
  return last + duration < nowMs;
}

export type AcquireDecision =
  | { action: "create" }
  | { action: "mine" }
  | { action: "take-over"; resourceVersion: string; why: "free" | "expired" }
  | { action: "wait"; holder: string };

/** What to do about the upgrade Lease when we want it. */
export function acquireDecision(lease: k8s.V1Lease | null, me: string, nowMs: number): AcquireDecision {
  if (!lease) return { action: "create" };
  const holder = leaseHolder(lease);
  const rv = lease.metadata?.resourceVersion ?? "";
  if (holder === me) return { action: "mine" };
  if (holder === "") return { action: "take-over", resourceVersion: rv, why: "free" };
  if (leaseExpired(lease, nowMs)) return { action: "take-over", resourceVersion: rv, why: "expired" };
  return { action: "wait", holder };
}

export function leasePhase(lease: k8s.V1Lease | null): Phase | undefined {
  const p = lease?.metadata?.annotations?.[UPGRADE_ANNOTATIONS.PHASE];
  return p === "upgrading" || p === "rebooting" || p === "held" ? p : undefined;
}

// --- Node health ---

export function isControlPlane(node: k8s.V1Node): boolean {
  return CONTROL_PLANE_LABEL in (node.metadata?.labels ?? {});
}

/**
 * Ready=True with a fresh heartbeat. Freshness takes the newer of the Ready
 * condition's lastHeartbeatTime and the kube-node-lease renewTime: kubelet
 * only rewrites an unchanged node status every 5 min (nodeStatusReportFrequency),
 * while it renews its node Lease every ~10 s — so the Ready heartbeat alone
 * would routinely look stale.
 */
export function nodeHealthProblem(
  node: k8s.V1Node,
  nodeLeaseRenewMs: number | undefined,
  nowMs: number,
): string | null {
  const name = node.metadata?.name ?? "?";
  const ready = node.status?.conditions?.find((c) => c.type === "Ready");
  if (!ready || ready.status !== "True") return `${name} not Ready`;
  const hb = Math.max(toMs(ready.lastHeartbeatTime) ?? 0, nodeLeaseRenewMs ?? 0);
  const age = nowMs - hb;
  if (age > HEARTBEAT_MAX_AGE_MS) return `${name} heartbeat ${Math.round(age / 1000)}s old`;
  return null;
}

/**
 * Problems blocking an upgrade step: every control-plane node (plus `self`,
 * if given and not a control-plane node) must be Ready and fresh.
 */
export function clusterHealthProblems(
  nodes: k8s.V1Node[],
  nodeLeaseRenewMs: Map<string, number>,
  nowMs: number,
  self?: string,
): string[] {
  const relevant = nodes.filter((n) => isControlPlane(n) || n.metadata?.name === self);
  const problems: string[] = [];
  if (!relevant.some(isControlPlane)) problems.push("no control-plane nodes found");
  for (const n of relevant) {
    const p = nodeHealthProblem(n, nodeLeaseRenewMs.get(n.metadata?.name ?? ""), nowMs);
    if (p) problems.push(p);
  }
  return problems;
}

/** First InternalIP of a node, preferring IPv4. */
export function nodeInternalIp(node: k8s.V1Node): string | undefined {
  const ips = (node.status?.addresses ?? []).filter((a) => a.type === "InternalIP").map((a) => a.address);
  return ips.find((ip) => !ip.includes(":")) ?? ips[0];
}

// --- Drain ---

/**
 * Pods a drain must evict and wait out: everything on the node except
 * DaemonSet-owned pods, mirror (static) pods and pods that already finished.
 */
export function podsToDrain(pods: k8s.V1Pod[], nodeName: string): k8s.V1Pod[] {
  return pods.filter((p) => {
    if (p.spec?.nodeName !== nodeName) return false;
    if (p.metadata?.annotations?.["kubernetes.io/config.mirror"] !== undefined) return false;
    if ((p.metadata?.ownerReferences ?? []).some((o) => o.kind === "DaemonSet" && o.controller)) return false;
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") return false;
    return true;
  });
}

// --- Host unit ---

export interface UnitState {
  activeState: string; // active | activating | inactive | failed | deactivating ...
  result: string;      // success | exit-code | timeout | ...
  invocationId: string;
  loadState?: string;  // loaded | not-found | ...
}

export function parseSystemctlShow(out: string): UnitState {
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return {
    activeState: kv.ActiveState ?? "",
    result: kv.Result ?? "",
    invocationId: kv.InvocationID ?? "",
    loadState: kv.LoadState ?? "",
  };
}

export function unitRunning(u: UnitState): boolean {
  return u.activeState === "activating" || u.activeState === "active" || u.activeState === "deactivating"
    || u.activeState === "reloading";
}

export type Outcome = "switched" | "reboot-required" | "failed";

export interface StateFile {
  outcome: Outcome;
  system?: string;
  time?: string;
  error?: string;
}

export function parseStateFile(text: string | null): StateFile | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j && (j.outcome === "switched" || j.outcome === "reboot-required" || j.outcome === "failed")) return j;
  } catch { /* fall through */ }
  return null;
}

/**
 * Outcome of a finished seed-upgrade.service run. The state file only counts
 * if it was written by this run (time >= when phase=upgrading began; the
 * host writes second precision) and the unit itself succeeded.
 */
export function classifyRun(
  unit: UnitState,
  state: StateFile | null,
  startedMs: number | undefined,
): { outcome: Outcome; detail: string } {
  if (!state) return { outcome: "failed", detail: "no state file from seed-upgrade.service" };
  const written = toMs(state.time);
  if (startedMs !== undefined && (written === undefined || written < Math.floor(startedMs / 1000) * 1000)) {
    return { outcome: "failed", detail: `state file predates this upgrade (${state.time ?? "no time"})` };
  }
  if (state.outcome === "failed") return { outcome: "failed", detail: state.error ?? "seed-upgrade.service reported failure" };
  if (unit.activeState === "failed" || (unit.result !== "" && unit.result !== "success")) {
    return { outcome: "failed", detail: `seed-upgrade.service ${unit.activeState}/${unit.result}` };
  }
  return { outcome: state.outcome, detail: state.system ?? "" };
}

// --- Resume on start ---

export type ResumeAction =
  /** Lease not ours: nothing to resume. */
  | { kind: "none" }
  /** Ours but no phase (died before/after the work, or dry-run): uncordon-if-ours + release. */
  | { kind: "abandoned" }
  /** phase=held: keep renewing, a human decides. */
  | { kind: "hold"; reason: string }
  /** Rebooted into the new system: health gate, uncordon-if-ours, release. */
  | { kind: "post-reboot" }
  /** phase=rebooting but same boot: issue the reboot again (attempt n). */
  | { kind: "reissue-reboot"; attempt: number }
  /** phase=upgrading and the host unit is still running: keep polling it. */
  | { kind: "poll-unit" }
  /** phase=upgrading and the unit finished: continue from its outcome. */
  | { kind: "outcome"; outcome: Outcome; detail: string };

export interface ResumeInput {
  lease: k8s.V1Lease | null;
  me: string;
  currentBootId: string;
  unit: UnitState;
  stateFile: StateFile | null;
}

/** Decide how to pick up an upgrade this node was in the middle of. */
export function decideResume(input: ResumeInput): ResumeAction {
  const { lease, me, currentBootId, unit, stateFile } = input;
  if (!lease || leaseHolder(lease) !== me) return { kind: "none" };
  const ann = lease.metadata?.annotations ?? {};
  switch (leasePhase(lease)) {
    case undefined:
      return { kind: "abandoned" };
    case "held":
      return { kind: "hold", reason: ann[UPGRADE_ANNOTATIONS.HOLD_REASON] ?? "held" };
    case "rebooting": {
      const recorded = ann[UPGRADE_ANNOTATIONS.BOOT_ID] ?? "";
      if (recorded !== "" && currentBootId !== "" && recorded !== currentBootId) return { kind: "post-reboot" };
      const attempts = Number(ann[UPGRADE_ANNOTATIONS.REBOOT_ATTEMPTS] ?? "1") || 1;
      if (attempts >= MAX_REBOOT_ATTEMPTS) {
        return { kind: "hold", reason: `reboot issued ${attempts} times but boot ID is still ${currentBootId}` };
      }
      return { kind: "reissue-reboot", attempt: attempts + 1 };
    }
    case "upgrading": {
      if (unitRunning(unit)) return { kind: "poll-unit" };
      const started = toMs(ann[UPGRADE_ANNOTATIONS.STARTED]);
      return { kind: "outcome", ...classifyRun(unit, stateFile, started) };
    }
  }
}
