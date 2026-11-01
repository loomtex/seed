// Upgrade agent — coordinates NixOS upgrades of this node through the
// seed-system/node-upgrade Lease so only one node upgrades at a time.
//
// Runs inside the host agent (privileged, hostPID), independent of netpol.
// The agent coordinates (Lease, cordon, drain, reboot, health gate); the
// host unit seed-upgrade.service (infra/profiles/seed-upgrade.nix) does the
// build + apply and writes /run/seed-upgrade/state. Host commands run in the
// host's namespaces via `nsenter -t 1`.
//
// Modes (SEED_UPGRADE_MODE):
//   dry-run (default) — at the window: pre-check, acquire, log the plan,
//                       wait 1 min, release. Host system.autoUpgrade still
//                       does the actual upgrade on its own timer.
//   active            — the full flow; host autoUpgrade timer is disabled.
//
// All decisions are pure functions in upgrade-logic.ts / upgrade-schedule.ts.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as k8s from "@kubernetes/client-node";
import { log, sleep, isNotFound, apiErrorCode, getOrNull, withApiRetry } from "../shared/kube.js";
import {
  LEASE_NAME, LEASE_NAMESPACE, LEASE_DURATION_SECONDS, UPGRADE_ANNOTATIONS as A,
  type Mode, type Outcome, type UnitState,
  acquireDecision, leaseHolder, leasePhase, clusterHealthProblems, isControlPlane,
  nodeInternalIp, podsToDrain, parseSystemctlShow, unitRunning, parseStateFile,
  classifyRun, decideResume, toMs,
} from "./upgrade-logic.js";
import {
  CONTROL_PLANE_LABEL, nodeSchedule, nextWindowAfter, windowCrossed, formatSecondsOfDay,
} from "./upgrade-schedule.js";

const COMPONENT = "upgrade";

const UNIT = "seed-upgrade.service";
const STATE_FILE = "/run/seed-upgrade/state";
/** Marker read by seed-upgrade.sh: classify this run as reboot-required. */
const FORCE_REBOOT_FILE = "/run/seed-upgrade/force-reboot";
const HOST_BIN = "/run/current-system/sw/bin";
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

const TICK_MS = 30_000;
const RENEW_MS = 60_000;
const ACQUIRE_RETRY_MS = 60_000;
const ACQUIRE_WAIT_MS = 60 * 60_000;
const UNIT_POLL_MS = 15_000;
const UNIT_START_WAIT_MS = 2 * 60_000;
const DRAIN_RETRY_MS = 10_000;
const DRAIN_TIMEOUT_MS = 15 * 60_000;
const HEALTH_POLL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 15 * 60_000;
const HEALTH_SETTLE_MS = 2 * 60_000;
const DRY_RUN_HOLD_MS = 60_000;
const REBOOT_WAIT_MS = 10 * 60_000;
const REISSUE_GRACE_MS = 5 * 60_000;

export interface UpgradeAgentConfig {
  nodeName: string;
  mode: Mode;
  tz: string;
}

class LeaseLost extends Error {}

type FlowResult = "done" | "held" | "rebooted";

const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

// --- host access ---

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Run a host binary in the host's mount/uts/ipc/net/pid namespaces. */
function hostExec(args: string[], timeoutMs?: number): Promise<string> {
  return run("/usr/bin/nsenter", ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", ...args], timeoutMs);
}

const systemctl = (...args: string[]) => hostExec([`${HOST_BIN}/systemctl`, ...args]);

async function unitState(): Promise<UnitState> {
  return parseSystemctlShow(await systemctl("show", UNIT, "-p", "ActiveState", "-p", "Result", "-p", "InvocationID", "-p", "LoadState", "--no-pager"));
}

async function readStateFile(): Promise<string | null> {
  try {
    return await hostExec([`${HOST_BIN}/cat`, STATE_FILE]);
  } catch {
    return null; // missing (tmpfs: gone after a reboot, or not written yet)
  }
}

/** /proc/sys/kernel/random/boot_id is not namespaced: the host's boot ID. */
function localBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

// --- Lease ---

class UpgradeLease {
  lost = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private coord: k8s.CoordinationV1Api, private me: string) {}

  read(): Promise<k8s.V1Lease | null> {
    return getOrNull(() => this.coord.readNamespacedLease({ name: LEASE_NAME, namespace: LEASE_NAMESPACE }));
  }

  /** Serialize lease writes (renewals vs. annotation updates). */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => {});
    return p;
  }

  /** One acquisition attempt. Returns true if we now hold the Lease. */
  async tryAcquire(): Promise<boolean> {
    return this.serial(async () => {
      const lease = await this.read();
      const d = acquireDecision(lease, this.me, Date.now());
      const now = new k8s.V1MicroTime();
      try {
        switch (d.action) {
          case "mine":
            return true;
          case "wait":
            log(COMPONENT, `lease held by ${d.holder}`);
            return false;
          case "create":
            await this.coord.createNamespacedLease({
              namespace: LEASE_NAMESPACE,
              body: {
                apiVersion: "coordination.k8s.io/v1",
                kind: "Lease",
                metadata: { name: LEASE_NAME, namespace: LEASE_NAMESPACE },
                spec: {
                  holderIdentity: this.me,
                  leaseDurationSeconds: LEASE_DURATION_SECONDS,
                  acquireTime: now,
                  renewTime: now,
                  leaseTransitions: 0,
                },
              },
            });
            break;
          case "take-over": {
            const body = structuredClone(lease!);
            body.metadata!.resourceVersion = d.resourceVersion;
            // A previous holder's progress means nothing to us.
            for (const k of Object.values(A)) delete body.metadata!.annotations?.[k];
            body.spec = {
              ...body.spec,
              holderIdentity: this.me,
              leaseDurationSeconds: LEASE_DURATION_SECONDS,
              acquireTime: now,
              renewTime: now,
              leaseTransitions: (body.spec?.leaseTransitions ?? 0) + 1,
            };
            await this.coord.replaceNamespacedLease({ name: LEASE_NAME, namespace: LEASE_NAMESPACE, body });
            if (d.why === "expired") log(COMPONENT, `took over expired lease from ${leaseHolder(lease)}`);
            break;
          }
        }
        this.lost = false;
        return true;
      } catch (err) {
        if (apiErrorCode(err) === 409) log(COMPONENT, "lease acquire conflict, backing off");
        else log(COMPONENT, `lease acquire failed: ${err}`);
        return false;
      }
    });
  }

  /**
   * Read-modify-write the Lease while we hold it (resourceVersion-guarded,
   * re-read on 409). Throws LeaseLost if it's gone or held by someone else.
   */
  mutate(fn: (lease: k8s.V1Lease) => void): Promise<void> {
    return this.serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const lease = await this.read();
        if (!lease || leaseHolder(lease) !== this.me) {
          this.lost = true;
          throw new LeaseLost(lease ? `lease now held by ${leaseHolder(lease) || "nobody"}` : "lease deleted");
        }
        const body = structuredClone(lease);
        fn(body);
        try {
          await this.coord.replaceNamespacedLease({ name: LEASE_NAME, namespace: LEASE_NAMESPACE, body });
          return;
        } catch (err) {
          if (apiErrorCode(err) !== 409 || attempt >= 4) throw err;
        }
      }
    });
  }

  renew(): Promise<void> {
    return this.mutate((l) => { l.spec = { ...l.spec, renewTime: new k8s.V1MicroTime() }; });
  }

  /** Set (string) or remove (null) progress annotations; also renews. */
  annotate(changes: Record<string, string | null>): Promise<void> {
    return withApiRetry("annotate upgrade lease", () => this.mutate((l) => {
      const ann = { ...(l.metadata!.annotations ?? {}) };
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete ann[k];
        else ann[k] = v;
      }
      l.metadata!.annotations = ann;
      l.spec = { ...l.spec, renewTime: new k8s.V1MicroTime() };
    }));
  }

  /** Renew every 60 s via the API Service; errors (local server restarting) are tolerated. */
  startRenewing(): void {
    if (this.timer) return;
    const tick = () => {
      this.renew().catch((err) => {
        if (err instanceof LeaseLost) log(COMPONENT, `lease lost: ${err.message}`);
        else log(COMPONENT, `lease renew failed (will retry): ${err}`);
      });
    };
    tick();
    this.timer = setInterval(tick, RENEW_MS);
  }

  stopRenewing(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Clear holderIdentity + our annotations; never touches someone else's Lease. */
  async release(): Promise<void> {
    this.stopRenewing();
    try {
      await withApiRetry("release upgrade lease", () => this.mutate((l) => {
        for (const k of Object.values(A)) delete l.metadata!.annotations?.[k];
        l.spec = { ...l.spec, holderIdentity: undefined };
      }));
      log(COMPONENT, "lease released");
    } catch (err) {
      if (err instanceof LeaseLost) log(COMPONENT, `not releasing: ${err.message}`);
      else throw err;
    }
  }
}

// --- the agent ---

class UpgradeAgent {
  private core: k8s.CoreV1Api;
  private coord: k8s.CoordinationV1Api;
  private lease: UpgradeLease;
  private me: string;

  constructor(private kc: k8s.KubeConfig, private cfg: UpgradeAgentConfig) {
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.coord = kc.makeApiClient(k8s.CoordinationV1Api);
    this.me = cfg.nodeName;
    this.lease = new UpgradeLease(this.coord, this.me);
  }

  private async event(type: "Normal" | "Warning", reason: string, message: string): Promise<void> {
    log(COMPONENT, `${type} ${reason}: ${message}`);
    const now = new Date();
    try {
      await this.core.createNamespacedEvent({
        namespace: "default",
        body: {
          apiVersion: "v1",
          kind: "Event",
          metadata: { generateName: `${this.me}.upgrade.`, namespace: "default" },
          // kubelet (and kubectl describe node) use the node name as the UID
          involvedObject: { apiVersion: "v1", kind: "Node", name: this.me, uid: this.me },
          type, reason, message,
          firstTimestamp: now, lastTimestamp: now, count: 1,
          source: { component: "seed-upgrade-agent", host: this.me },
          reportingComponent: "seed-upgrade-agent",
          reportingInstance: this.me,
        },
      });
    } catch {
      // best-effort
    }
  }

  // --- cluster reads ---

  private async nodes(): Promise<k8s.V1Node[]> {
    return (await withApiRetry("list nodes", () => this.core.listNode())).items;
  }

  private async nodeLeaseRenewals(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    try {
      const { items } = await this.coord.listNamespacedLease({ namespace: "kube-node-lease" });
      for (const l of items) {
        const t = toMs(l.spec?.renewTime);
        if (l.metadata?.name && t !== undefined) m.set(l.metadata.name, t);
      }
    } catch (err) {
      log(COMPONENT, `node leases unreadable, using Ready heartbeats only: ${err}`);
    }
    return m;
  }

  private async readyz(node: k8s.V1Node): Promise<string | null> {
    const ip = nodeInternalIp(node);
    if (!ip) return `${this.me} has no InternalIP`;
    let token: string, ca: Buffer;
    try {
      token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
      ca = readFileSync(`${SA_DIR}/ca.crt`);
    } catch (err) {
      return `no service account credentials: ${err}`;
    }
    return new Promise((resolve) => {
      const req = https.request(
        { host: ip, port: 6443, path: "/readyz", method: "GET", ca, headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
        (res) => {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => resolve(res.statusCode === 200 ? null : `${ip}:6443/readyz ${res.statusCode}: ${body.slice(0, 200)}`));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (err) => resolve(`${ip}:6443/readyz: ${err.message}`));
      req.end();
    });
  }

  /** Pre-check (control plane only) or health gate (plus self + local /readyz). */
  private async healthProblems(gate: boolean): Promise<string[]> {
    try {
      const nodes = await this.nodes();
      const problems = clusterHealthProblems(nodes, await this.nodeLeaseRenewals(), Date.now(), gate ? this.me : undefined);
      if (gate) {
        const self = nodes.find((n) => n.metadata?.name === this.me);
        if (!self) problems.push(`${this.me} not in node list`);
        else if (isControlPlane(self)) {
          const r = await this.readyz(self);
          if (r) problems.push(r);
        }
      }
      return problems;
    } catch (err) {
      return [`health check failed: ${err}`];
    }
  }

  /** Wait until healthy, settle 2 min, confirm. False after 15 min unhealthy. */
  private async healthGate(): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let last: string[] = [];
    while (Date.now() < deadline) {
      this.checkLease();
      last = await this.healthProblems(true);
      if (last.length === 0) {
        log(COMPONENT, `health gate passed, settling ${HEALTH_SETTLE_MS / 1000}s`);
        await sleep(HEALTH_SETTLE_MS);
        last = await this.healthProblems(true);
        if (last.length === 0) return true;
      }
      log(COMPONENT, `health gate waiting: ${last.join("; ")}`);
      await sleep(HEALTH_POLL_MS);
    }
    await this.event("Warning", "UpgradeUnhealthy", `health gate failed after ${HEALTH_TIMEOUT_MS / 60_000} min: ${last.join("; ")}`);
    return false;
  }

  private checkLease(): void {
    if (this.lease.lost) throw new LeaseLost("lease lost while upgrading");
  }

  // --- node operations ---

  private readNode(): Promise<k8s.V1Node> {
    return this.core.readNode({ name: this.me });
  }

  private patchNode(body: object): Promise<k8s.V1Node> {
    return this.core.patchNode({ name: this.me, body }, mergePatch);
  }

  /** Cordon; mark it ours only if the node wasn't already cordoned. */
  private async cordon(): Promise<void> {
    await withApiRetry("cordon", async () => {
      const node = await this.readNode();
      if (node.spec?.unschedulable) {
        const ours = node.metadata?.annotations?.[A.CORDONED] === "true";
        log(COMPONENT, `node already cordoned${ours ? " (by us)" : " (not by us; will leave it cordoned)"}`);
        return;
      }
      await this.patchNode({
        metadata: { resourceVersion: node.metadata?.resourceVersion, annotations: { [A.CORDONED]: "true" } },
        spec: { unschedulable: true },
      });
      log(COMPONENT, "cordoned");
    });
  }

  private async uncordonIfOurs(): Promise<void> {
    await withApiRetry("uncordon", async () => {
      const node = await this.readNode();
      if (node.metadata?.annotations?.[A.CORDONED] !== "true") {
        log(COMPONENT, node.spec?.unschedulable ? "cordon is not ours, leaving node cordoned" : "node not cordoned");
        return;
      }
      await this.patchNode({
        metadata: { resourceVersion: node.metadata?.resourceVersion, annotations: { [A.CORDONED]: null } },
        spec: { unschedulable: false },
      });
      log(COMPONENT, "uncordoned");
    });
  }

  private async podsOnNode(): Promise<k8s.V1Pod[]> {
    const { items } = await withApiRetry("list node pods", () =>
      this.core.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${this.me}` }));
    return podsToDrain(items, this.me);
  }

  /** Evict everything but DaemonSet/mirror pods; true once they're all gone. */
  private async drain(): Promise<boolean> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    for (;;) {
      this.checkLease();
      const pods = await this.podsOnNode();
      if (pods.length === 0) {
        log(COMPONENT, "drain complete");
        return true;
      }
      if (Date.now() > deadline) {
        const left = pods.map((p) => `${p.metadata?.namespace}/${p.metadata?.name}`).join(", ");
        await this.event("Warning", "UpgradeDrainTimeout", `drain timed out after ${DRAIN_TIMEOUT_MS / 60_000} min, not rebooting; remaining: ${left}`);
        return false;
      }
      for (const p of pods) {
        if (p.metadata?.deletionTimestamp) continue;
        const name = p.metadata!.name!, namespace = p.metadata!.namespace!;
        try {
          await this.core.createNamespacedPodEviction({
            name, namespace,
            body: { apiVersion: "policy/v1", kind: "Eviction", metadata: { name, namespace } },
          });
          log(COMPONENT, `evicted ${namespace}/${name}`);
        } catch (err) {
          if (isNotFound(err)) continue;
          if (apiErrorCode(err) === 429) log(COMPONENT, `eviction of ${namespace}/${name} blocked (PDB), retrying`);
          else log(COMPONENT, `eviction of ${namespace}/${name} failed: ${err}`);
        }
      }
      await sleep(DRAIN_RETRY_MS);
    }
  }

  // --- flow ---

  private async finish(message: string): Promise<FlowResult> {
    await this.uncordonIfOurs();
    await this.lease.release();
    await this.event("Normal", "UpgradeComplete", message);
    return "done";
  }

  /** Keep renewing and do nothing else until a human deletes / takes the Lease. */
  private async hold(reason: string, alreadyHeld = false): Promise<FlowResult> {
    if (!alreadyHeld) {
      await this.lease.annotate({ [A.PHASE]: "held", [A.HOLD_REASON]: reason.slice(0, 1000) })
        .catch((err) => log(COMPONENT, `could not record hold: ${err}`));
      await this.event("Warning", "UpgradeHeld",
        `holding upgrade lease: ${reason}. To resolve: fix the node, uncordon it if needed, then kubectl delete lease ${LEASE_NAME} -n ${LEASE_NAMESPACE}`);
    } else {
      log(COMPONENT, `still holding upgrade lease: ${reason}`);
    }
    this.lease.startRenewing();
    while (!this.lease.lost) await sleep(RENEW_MS);
    this.lease.stopRenewing();
    log(COMPONENT, "hold ended (lease deleted or taken over)");
    return "held";
  }

  private async reboot(attempt: number): Promise<FlowResult> {
    const bootId = localBootId() || (await this.readNode()).status?.nodeInfo?.bootID || "";
    await this.lease.annotate({ [A.PHASE]: "rebooting", [A.BOOT_ID]: bootId, [A.REBOOT_ATTEMPTS]: String(attempt) });
    await this.event("Normal", "UpgradeRebooting", `rebooting into the new system (attempt ${attempt}, boot ${bootId})`);
    await systemctl("reboot");
    // Normally we die here. If we're still around later, re-evaluate.
    await sleep(REBOOT_WAIT_MS);
    return "rebooted";
  }

  private async handleOutcome(outcome: Outcome, detail: string): Promise<FlowResult> {
    switch (outcome) {
      case "switched":
        log(COMPONENT, `switched to ${detail}`);
        if (await this.healthGate()) return this.finish(`upgraded in place to ${detail}`);
        return this.hold("cluster unhealthy after switch");
      case "reboot-required":
        log(COMPONENT, `reboot required for ${detail}, draining`);
        if (!(await this.drain())) return this.hold("drain timed out");
        return this.reboot(1);
      case "failed":
        await this.event("Warning", "UpgradeFailed", `seed-upgrade.service failed: ${detail}`);
        if (await this.healthGate()) {
          await this.uncordonIfOurs();
          await this.lease.release();
          return "done";
        }
        return this.hold(`upgrade failed (${detail}) and cluster unhealthy`);
    }
  }

  /** Wait for the host unit to finish, then act on its outcome. */
  private async continueUpgrading(startedMs: number | undefined, prevInvocation?: string): Promise<FlowResult> {
    if (prevInvocation !== undefined) {
      // We just queued it (--no-block): wait for this run to begin.
      const deadline = Date.now() + UNIT_START_WAIT_MS;
      for (;;) {
        const u = await unitState();
        if (u.invocationId !== prevInvocation || unitRunning(u)) break;
        if (Date.now() > deadline) return this.handleOutcome("failed", `${UNIT} did not start`);
        await sleep(5_000);
      }
    }
    for (;;) {
      this.checkLease();
      let u: UnitState;
      try {
        u = await unitState();
      } catch (err) {
        log(COMPONENT, `systemctl show failed (retrying): ${err}`);
        await sleep(UNIT_POLL_MS);
        continue;
      }
      if (!unitRunning(u)) {
        const { outcome, detail } = classifyRun(u, parseStateFile(await readStateFile()), startedMs);
        return this.handleOutcome(outcome, detail);
      }
      await sleep(UNIT_POLL_MS);
    }
  }

  private async activeFlow(reason: string, forceReboot = false): Promise<FlowResult> {
    // Preflight before touching the node: the host must already run a
    // system with seed-upgrade.service (rollout ordering), and it mustn't
    // be running already (e.g. started by hand).
    const before = await unitState();
    if (before.loadState !== "loaded" || unitRunning(before)) {
      await this.event("Warning", "UpgradeSkipped",
        `${UNIT} is ${before.loadState !== "loaded" ? `not available (LoadState=${before.loadState})` : `already ${before.activeState}`}; not upgrading`);
      await this.lease.release();
      return "done";
    }
    await this.cordon();
    const started = new Date();
    await this.lease.annotate({ [A.PHASE]: "upgrading", [A.STARTED]: started.toISOString() });
    if (forceReboot) {
      await hostExec([`${HOST_BIN}/mkdir`, "-p", "/run/seed-upgrade"]);
      await hostExec([`${HOST_BIN}/touch`, FORCE_REBOOT_FILE]);
    }
    await systemctl("start", "--no-block", UNIT);
    await this.event("Normal", "UpgradeStarted", `started ${UNIT} (${reason})`);
    return this.continueUpgrading(started.getTime(), before.invocationId);
  }

  private async dryRun(reason: string, forceReboot = false): Promise<FlowResult> {
    const node = await this.readNode();
    const pods = await this.podsOnNode();
    const health = await this.healthProblems(true);
    const plan = [
      node.spec?.unschedulable ? "node already cordoned: would leave the cordon alone" : "would cordon the node",
      forceReboot ? `would request a reboot (${FORCE_REBOOT_FILE}), then start ${UNIT} and wait for ${STATE_FILE}` : `would start ${UNIT} and wait for ${STATE_FILE}`,
      "if switched: health gate (control plane Ready + local /readyz), wait 2 min, uncordon, release",
      `if reboot-required: drain ${pods.length} pod(s) [${pods.map((p) => `${p.metadata?.namespace}/${p.metadata?.name}`).join(", ")}], then reboot`,
      `health gate right now: ${health.length === 0 ? "pass" : health.join("; ")}`,
    ];
    for (const step of plan) log(COMPONENT, `[dry-run] ${step}`);
    await this.event("Normal", "UpgradeDryRun", `dry-run (${reason}): holding the lease ${DRY_RUN_HOLD_MS / 1000}s, no changes made`);
    await sleep(DRY_RUN_HOLD_MS);
    await this.lease.release();
    return "done";
  }

  /** Pick up an upgrade this node was in the middle of (Lease held by us). */
  private async resumeOnce(): Promise<FlowResult | "none"> {
    const lease = await withApiRetry("read upgrade lease", () => this.lease.read());
    if (leaseHolder(lease) !== this.me) {
      const node = await this.readNode().catch(() => null);
      if (node?.metadata?.annotations?.[A.CORDONED] === "true" && node.spec?.unschedulable) {
        await this.event("Warning", "UpgradeOrphanedCordon",
          "node is cordoned by the upgrade agent but this node no longer holds the upgrade lease; uncordon by hand once healthy");
      }
      return "none";
    }
    this.lease.lost = false;
    this.lease.startRenewing();
    let unit: UnitState = { activeState: "", result: "", invocationId: "" };
    try {
      unit = await unitState();
    } catch (err) {
      log(COMPONENT, `systemctl show failed: ${err}`);
    }
    const bootId = localBootId() || (await this.readNode()).status?.nodeInfo?.bootID || "";
    const action = decideResume({
      lease, me: this.me, currentBootId: bootId, unit,
      stateFile: leasePhase(lease) === "upgrading" ? parseStateFile(await readStateFile()) : null,
    });
    log(COMPONENT, `resuming: ${JSON.stringify(action)}`);
    const started = toMs(lease?.metadata?.annotations?.[A.STARTED]);
    switch (action.kind) {
      case "none":
        return "none";
      case "abandoned":
        await this.uncordonIfOurs();
        await this.lease.release();
        return "done";
      case "hold":
        return this.hold(action.reason, leasePhase(lease) === "held");
      case "post-reboot":
        await this.event("Normal", "UpgradeRebooted", `back up on boot ${bootId}`);
        if (await this.healthGate()) return this.finish("upgraded via reboot");
        return this.hold("cluster unhealthy after reboot");
      case "reissue-reboot": {
        // A shutdown may simply still be in progress; give it time first.
        await sleep(REISSUE_GRACE_MS);
        if (localBootId() !== bootId) return "rebooted";
        await this.event("Warning", "UpgradeRebootRetry", `boot ID unchanged (${bootId}), re-issuing reboot`);
        return this.reboot(action.attempt);
      }
      case "poll-unit":
        return this.continueUpgrading(started);
      case "outcome":
        return this.handleOutcome(action.outcome, action.detail);
    }
  }

  private async resume(): Promise<void> {
    for (;;) {
      const r = await this.guard(() => this.resumeOnce());
      if (r !== "rebooted") return;
    }
  }

  /** Run a flow step; LeaseLost / unexpected errors end it without throwing. */
  private async guard<T>(f: () => Promise<T>): Promise<T | "error"> {
    try {
      return await f();
    } catch (err) {
      this.lease.stopRenewing();
      if (err instanceof LeaseLost) {
        await this.event("Warning", "UpgradeLeaseLost", `${err.message}; stopped mid-upgrade, check the node (cordon, system state)`);
      } else {
        await this.event("Warning", "UpgradeError", `upgrade flow error: ${err instanceof Error ? err.message : String(err)}`);
        const lease = await this.lease.read().catch(() => null);
        if (leaseHolder(lease) === this.me && leasePhase(lease) === undefined) {
          // Nothing started yet (dry-run, or failed before the host unit was
          // triggered): undo our cordon, if any, and let go.
          try {
            await this.uncordonIfOurs();
            await this.lease.release();
          } catch (e) {
            log(COMPONENT, `cleanup after error failed (resume on restart will retry): ${e}`);
          }
        } else if (leaseHolder(lease) === this.me) {
          // Mid-upgrade: hold rather than walk away from a half-done upgrade.
          return (await this.hold(`flow error: ${err instanceof Error ? err.message : String(err)}`).catch(() => "error")) as T | "error";
        }
      }
      return "error";
    }
  }

  private async attempt(reason: string, forceReboot = false): Promise<void> {
    const problems = await this.healthProblems(false);
    if (problems.length > 0) {
      await this.event("Warning", "UpgradeSkipped", `${reason} upgrade skipped, control plane not healthy: ${problems.join("; ")}`);
      return;
    }
    const existing = await this.lease.read().catch(() => null);
    if (leaseHolder(existing) === this.me) {
      log(COMPONENT, "already hold the upgrade lease; resuming instead of starting another upgrade");
      return this.resume();
    }
    const deadline = Date.now() + ACQUIRE_WAIT_MS;
    let acquired = false;
    for (;;) {
      const p = await this.healthProblems(false);
      if (p.length === 0 && (await this.lease.tryAcquire())) { acquired = true; break; }
      if (p.length > 0) log(COMPONENT, `waiting for lease, control plane not healthy: ${p.join("; ")}`);
      if (Date.now() + ACQUIRE_RETRY_MS > deadline) break;
      await sleep(ACQUIRE_RETRY_MS);
    }
    if (!acquired) {
      await this.event("Warning", "UpgradeLeaseUnavailable", `${reason} upgrade: could not acquire the lease within ${ACQUIRE_WAIT_MS / 60_000} min; waiting for the next window`);
      return;
    }
    log(COMPONENT, `acquired upgrade lease (${reason}, mode ${this.cfg.mode})`);
    this.lease.startRenewing();
    const r = await this.guard(() => this.cfg.mode === "active" ? this.activeFlow(reason, forceReboot) : this.dryRun(reason, forceReboot));
    if (r === "rebooted") await this.resume();
  }

  // --- main loop ---

  async run(): Promise<void> {
    log(COMPONENT, `starting: node ${this.me}, mode ${this.cfg.mode}, tz ${this.cfg.tz}`);
    await this.resume();

    let prev = Date.now();
    let lastPlan = "";
    for (;;) {
      await sleep(TICK_MS);
      const now = Date.now();
      try {
        const nodes = await this.nodes();
        const self = nodes.find((n) => n.metadata?.name === this.me);
        if (self?.metadata?.annotations?.[A.UPGRADE_NOW] === "true") {
          const forceReboot = self.metadata?.annotations?.[A.UPGRADE_REBOOT] === "true";
          // Removed up front so a reboot or restart mid-flow can't re-trigger it.
          await withApiRetry("clear upgrade-now", () => this.patchNode({ metadata: { annotations: { [A.UPGRADE_NOW]: null, [A.UPGRADE_REBOOT]: null } } }));
          await this.event("Normal", "UpgradeRequested", `${A.UPGRADE_NOW} annotation seen, running the upgrade flow once${forceReboot ? " with a reboot" : ""}`);
          await this.attempt("on-demand", forceReboot);
          prev = Date.now();
          continue;
        }
        const sched = nodeSchedule(nodes.map((n) => ({
          name: n.metadata?.name ?? "",
          controlPlane: CONTROL_PLANE_LABEL in (n.metadata?.labels ?? {}),
        })), this.me);
        if (!sched) {
          prev = now;
          continue;
        }
        const plan = `bucket ${sched.bucket} (index ${sched.index}), daily at ${formatSecondsOfDay(sched.secondsOfDay)} ${this.cfg.tz}`;
        if (plan !== lastPlan) {
          const next = new Date(nextWindowAfter(now, sched.secondsOfDay, this.cfg.tz));
          log(COMPONENT, `schedule: ${plan}; next window ${next.toISOString()}`);
          lastPlan = plan;
        }
        if (windowCrossed(prev, now, sched.secondsOfDay, this.cfg.tz)) {
          await this.attempt("scheduled");
          prev = Date.now(); // windows that passed during the attempt don't catch up
          continue;
        }
        prev = now;
      } catch (err) {
        log(COMPONENT, `tick failed: ${err instanceof Error ? err.message : String(err)}`);
        // Brief API outages may still fire a window late; long ones don't catch up.
        if (now - prev > 15 * 60_000) prev = now;
      }
    }
  }
}

/** Start the upgrade agent; never throws, restarts itself after errors. */
export function startUpgradeAgent(kc: k8s.KubeConfig, cfg: UpgradeAgentConfig): void {
  const loop = async () => {
    for (;;) {
      try {
        await new UpgradeAgent(kc, cfg).run();
      } catch (err) {
        log(COMPONENT, `upgrade agent crashed, restarting in 30s: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        await sleep(30_000);
      }
    }
  };
  void loop();
}
