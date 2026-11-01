// Tests for the upgrade agent's pure logic (host-agent/upgrade-*.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as k8s from "@kubernetes/client-node";
import {
  upgradeOrder, nodeSchedule, nodeJitterSeconds, nextWindowAfter, windowCrossed,
  zonedTimeToInstant, validTimeZone, formatSecondsOfDay, JITTER_SECONDS, CONTROL_PLANE_LABEL,
} from "../host-agent/upgrade-schedule.js";
import {
  UPGRADE_ANNOTATIONS as A, acquireDecision, leaseExpired, toMs, podsToDrain,
  clusterHealthProblems, nodeHealthProblem, classifyRun, decideResume, parseSystemctlShow,
  parseStateFile, parseMode, nodeInternalIp, type UnitState,
} from "../host-agent/upgrade-logic.js";

const sn = (name: string, controlPlane = true) => ({ name, controlPlane });

describe("upgrade schedule: order and buckets", () => {
  it("orders control-plane nodes first, each group by name", () => {
    const order = upgradeOrder([sn("w-b", false), sn("s-2"), sn("w-a", false), sn("s-1")]);
    assert.deepEqual(order, ["s-1", "s-2", "w-a", "w-b"]);
  });

  it("sorts byte-wise like Nix lib.lessThan (uppercase before lowercase)", () => {
    assert.deepEqual(upgradeOrder([sn("b"), sn("B"), sn("a")]), ["B", "a", "b"]);
  });

  it("puts agents round-robin after servers (3 servers + 3 agents, 4 buckets)", () => {
    const nodes = [
      sn("seed-atl1-1"), sn("seed-atl1-2"), sn("seed-atl1-3"),
      sn("agent-a", false), sn("agent-b", false), sn("agent-c", false),
    ];
    const buckets = Object.fromEntries(nodes.map((n) => [n.name, nodeSchedule(nodes, n.name)!.bucket]));
    assert.deepEqual(buckets, {
      "seed-atl1-1": 0, "seed-atl1-2": 1, "seed-atl1-3": 2,
      "agent-a": 3, "agent-b": 0, "agent-c": 1,
    });
  });

  it("maps buckets to 04:00 + 30 min steps plus jitter", () => {
    const nodes = [sn("seed-atl1-1"), sn("seed-atl1-2"), sn("seed-atl1-3")];
    for (const [i, name] of ["seed-atl1-1", "seed-atl1-2", "seed-atl1-3"].entries()) {
      const s = nodeSchedule(nodes, name)!;
      assert.equal(s.index, i);
      assert.equal(s.secondsOfDay, (240 + 30 * i) * 60 + nodeJitterSeconds(name));
    }
  });

  it("returns null for a node missing from the list", () => {
    assert.equal(nodeSchedule([sn("a")], "b"), null);
  });

  it("jitter is deterministic, in [0, 600) and differs between nodes", () => {
    assert.equal(nodeJitterSeconds("seed-atl1-1"), nodeJitterSeconds("seed-atl1-1"));
    const js = ["seed-atl1-1", "seed-atl1-2", "seed-atl1-3", "x", "y"].map(nodeJitterSeconds);
    for (const j of js) assert.ok(j >= 0 && j < JITTER_SECONDS && Number.isInteger(j));
    assert.ok(new Set(js).size > 1);
  });

  it("formats seconds of day", () => {
    assert.equal(formatSecondsOfDay(4 * 3600 + 30 * 60 + 7), "04:30:07");
  });
});

describe("upgrade schedule: time zones", () => {
  const tz = "America/Denver";

  it("converts local wall time across DST (MDT -6, MST -7)", () => {
    assert.equal(new Date(zonedTimeToInstant(2026, 7, 1, 4 * 3600, tz)).toISOString(), "2026-07-01T10:00:00.000Z");
    assert.equal(new Date(zonedTimeToInstant(2026, 12, 1, 4 * 3600, tz)).toISOString(), "2026-12-01T11:00:00.000Z");
  });

  it("handles the fall-back day (2026-11-01: 04:00 is after the change, MST)", () => {
    assert.equal(new Date(zonedTimeToInstant(2026, 11, 1, 4 * 3600, tz)).toISOString(), "2026-11-01T11:00:00.000Z");
    // 01:30 happens twice; the first (MDT) is chosen
    assert.equal(new Date(zonedTimeToInstant(2026, 11, 1, 5400, tz)).toISOString(), "2026-11-01T07:30:00.000Z");
  });

  it("handles the spring-forward gap (02:30 doesn't exist on 2026-03-08)", () => {
    const t = zonedTimeToInstant(2026, 3, 8, 2 * 3600 + 1800, tz);
    assert.equal(new Date(t).toISOString(), "2026-03-08T09:30:00.000Z"); // 03:30 MDT
  });

  it("next window: later today, or tomorrow once passed", () => {
    const at4 = 4 * 3600;
    // 2026-06-30 22:00 MDT → 2026-07-01 04:00 MDT
    assert.equal(new Date(nextWindowAfter(Date.parse("2026-07-01T04:00:00Z"), at4, tz)).toISOString(), "2026-07-01T10:00:00.000Z");
    // exactly at the window → the next day's
    assert.equal(new Date(nextWindowAfter(Date.parse("2026-07-01T10:00:00Z"), at4, tz)).toISOString(), "2026-07-02T10:00:00.000Z");
    // UTC zone
    assert.equal(new Date(nextWindowAfter(Date.parse("2026-07-01T05:00:00Z"), at4, "UTC")).toISOString(), "2026-07-02T04:00:00.000Z");
  });

  it("windowCrossed only fires when (prev, now] spans the window — no catch-up", () => {
    const at4 = 4 * 3600;
    const w = Date.parse("2026-07-01T10:00:00Z");
    assert.equal(windowCrossed(w - 30_000, w, at4, tz), true);
    assert.equal(windowCrossed(w - 30_000, w + 1, at4, tz), true);
    assert.equal(windowCrossed(w, w + 30_000, at4, tz), false); // already handled at prev
    assert.equal(windowCrossed(w + 60_000, w + 90_000, at4, tz), false); // started after the window
    assert.equal(windowCrossed(w - 90_000, w - 60_000, at4, tz), false);
  });

  it("validTimeZone falls back to UTC", () => {
    assert.equal(validTimeZone("America/Denver"), "America/Denver");
    assert.equal(validTimeZone("Not/AZone"), "UTC");
    assert.equal(validTimeZone(undefined), "UTC");
  });
});

// --- Lease ---

function lease(holder: string | undefined, renew: string | undefined, ann: Record<string, string> = {}, duration = 1800): k8s.V1Lease {
  return {
    metadata: { name: "node-upgrade", namespace: "seed-system", resourceVersion: "42", annotations: ann },
    spec: { holderIdentity: holder, renewTime: renew as unknown as Date, leaseDurationSeconds: duration },
  };
}

describe("upgrade lease math", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");

  it("expiry is renewTime + duration < now", () => {
    assert.equal(leaseExpired(lease("a", "2026-11-01T11:30:01.000000Z"), now), false);
    assert.equal(leaseExpired(lease("a", "2026-11-01T11:30:00.000000Z"), now), false); // exactly at the edge
    assert.equal(leaseExpired(lease("a", "2026-11-01T11:29:59.000000Z"), now), true);
    assert.equal(leaseExpired(lease("a", "2026-11-01T11:59:00Z", {}, 30), now), true);
  });

  it("no renew/acquire time counts as expired; acquireTime is the fallback", () => {
    assert.equal(leaseExpired(lease("a", undefined), now), true);
    const l = lease("a", undefined);
    l.spec!.acquireTime = "2026-11-01T11:59:00.000000Z" as unknown as Date;
    assert.equal(leaseExpired(l, now), false);
  });

  it("toMs accepts Date and MicroTime strings", () => {
    assert.equal(toMs("2026-11-01T12:00:00.123456Z"), Date.parse("2026-11-01T12:00:00.123Z"));
    assert.equal(toMs(new Date(5)), 5);
    assert.equal(toMs(undefined), undefined);
    assert.equal(toMs("garbage"), undefined);
  });

  it("acquire decisions", () => {
    assert.deepEqual(acquireDecision(null, "me", now), { action: "create" });
    assert.deepEqual(acquireDecision(lease("me", "2026-11-01T11:59:00Z"), "me", now), { action: "mine" });
    assert.deepEqual(acquireDecision(lease("other", "2026-11-01T11:59:00Z"), "me", now), { action: "wait", holder: "other" });
    assert.deepEqual(acquireDecision(lease("other", "2026-11-01T10:00:00Z"), "me", now),
      { action: "take-over", resourceVersion: "42", why: "expired" });
    assert.deepEqual(acquireDecision(lease(undefined, "2026-11-01T11:59:00Z"), "me", now),
      { action: "take-over", resourceVersion: "42", why: "free" });
    assert.deepEqual(acquireDecision(lease("", "2026-11-01T11:59:00Z"), "me", now),
      { action: "take-over", resourceVersion: "42", why: "free" });
  });
});

// --- Health ---

function node(name: string, opts: { cp?: boolean; ready?: string; hb?: string; ips?: string[] } = {}): k8s.V1Node {
  return {
    metadata: { name, labels: opts.cp === false ? {} : { [CONTROL_PLANE_LABEL]: "true" } },
    status: {
      conditions: [{ type: "Ready", status: opts.ready ?? "True", lastHeartbeatTime: (opts.hb ?? "2026-11-01T11:59:30Z") as unknown as Date }],
      addresses: (opts.ips ?? []).map((address) => ({ type: "InternalIP", address })),
    },
  };
}

describe("upgrade health checks", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");

  it("Ready + heartbeat within 2 min passes", () => {
    assert.equal(nodeHealthProblem(node("a"), undefined, now), null);
  });

  it("not Ready fails", () => {
    assert.match(nodeHealthProblem(node("a", { ready: "Unknown" }), undefined, now)!, /not Ready/);
  });

  it("stale Ready heartbeat is rescued by a fresh node Lease (kubelet reports status every 5 min)", () => {
    const n = node("a", { hb: "2026-11-01T11:55:30Z" });
    assert.match(nodeHealthProblem(n, undefined, now)!, /heartbeat 270s old/);
    assert.equal(nodeHealthProblem(n, Date.parse("2026-11-01T11:59:55Z"), now), null);
    assert.match(nodeHealthProblem(n, Date.parse("2026-11-01T11:57:00Z"), now)!, /heartbeat/);
  });

  it("cluster check covers control-plane nodes, and self only when asked", () => {
    const nodes = [node("s1"), node("s2", { ready: "False" }), node("w1", { cp: false, ready: "False" })];
    assert.deepEqual(clusterHealthProblems(nodes, new Map(), now), ["s2 not Ready"]);
    assert.deepEqual(clusterHealthProblems(nodes, new Map(), now, "w1"), ["s2 not Ready", "w1 not Ready"]);
    assert.deepEqual(clusterHealthProblems([node("w1", { cp: false })], new Map(), now), ["no control-plane nodes found"]);
  });

  it("InternalIP prefers IPv4", () => {
    assert.equal(nodeInternalIp(node("a", { ips: ["fd02::10", "10.0.0.10"] })), "10.0.0.10");
    assert.equal(nodeInternalIp(node("a", { ips: ["fd02::10"] })), "fd02::10");
    assert.equal(nodeInternalIp(node("a")), undefined);
  });
});

// --- Drain ---

function pod(name: string, opts: { node?: string; owner?: string; controller?: boolean; mirror?: boolean; phase?: string } = {}): k8s.V1Pod {
  return {
    metadata: {
      name, namespace: "ns",
      annotations: opts.mirror ? { "kubernetes.io/config.mirror": "abc" } : {},
      ownerReferences: opts.owner ? [{ apiVersion: "apps/v1", kind: opts.owner, name: "o", uid: "u", controller: opts.controller ?? true }] : [],
    },
    spec: { nodeName: opts.node ?? "n1", containers: [] },
    status: { phase: opts.phase ?? "Running" },
  };
}

describe("drain pod filtering", () => {
  it("evicts Deployment/ReplicaSet, Job and bare pods; skips DaemonSet, mirror, finished and other-node pods", () => {
    const pods = [
      pod("instance", { owner: "ReplicaSet" }),
      pod("job", { owner: "Job" }),
      pod("bare"),
      pod("ds", { owner: "DaemonSet" }),
      pod("ds-noncontroller", { owner: "DaemonSet", controller: false }),
      pod("mirror", { mirror: true }),
      pod("done", { phase: "Succeeded" }),
      pod("crashed", { phase: "Failed" }),
      pod("pending", { phase: "Pending" }),
      pod("elsewhere", { node: "n2" }),
    ];
    assert.deepEqual(podsToDrain(pods, "n1").map((p) => p.metadata!.name),
      ["instance", "job", "bare", "ds-noncontroller", "pending"]);
  });
});

// --- Host unit / resume ---

const inactive: UnitState = { activeState: "inactive", result: "success", invocationId: "i2" };
const failedUnit: UnitState = { activeState: "failed", result: "exit-code", invocationId: "i2" };
const running: UnitState = { activeState: "activating", result: "success", invocationId: "i2" };
const STARTED = "2026-11-01T11:00:00.500Z";
const startedMs = Date.parse(STARTED);

describe("host unit parsing and run classification", () => {
  it("parses systemctl show", () => {
    assert.deepEqual(parseSystemctlShow("ActiveState=failed\nResult=exit-code\nInvocationID=abc\nLoadState=loaded\n"),
      { activeState: "failed", result: "exit-code", invocationId: "abc", loadState: "loaded" });
    assert.equal(parseSystemctlShow("LoadState=not-found\nActiveState=inactive\n").loadState, "not-found");
  });

  it("parses state files, rejecting junk", () => {
    assert.deepEqual(parseStateFile('{"outcome":"switched","system":"/nix/store/x","time":"t"}'),
      { outcome: "switched", system: "/nix/store/x", time: "t" });
    assert.equal(parseStateFile('{"outcome":"weird"}'), null);
    assert.equal(parseStateFile("not json"), null);
    assert.equal(parseStateFile(null), null);
  });

  it("uses the state file outcome when written by this run and the unit succeeded", () => {
    // host writes second precision: 11:00:00 counts for a run started 11:00:00.500
    const st = { outcome: "reboot-required" as const, system: "/nix/store/new", time: "2026-11-01T11:00:00Z" };
    assert.deepEqual(classifyRun(inactive, st, startedMs), { outcome: "reboot-required", detail: "/nix/store/new" });
  });

  it("stale or missing state file means failed", () => {
    assert.equal(classifyRun(inactive, { outcome: "switched", time: "2026-11-01T10:59:59Z" }, startedMs).outcome, "failed");
    assert.equal(classifyRun(inactive, { outcome: "switched" }, startedMs).outcome, "failed");
    assert.equal(classifyRun(inactive, null, startedMs).outcome, "failed");
  });

  it("failed unit or failed state means failed, with the error as detail", () => {
    assert.deepEqual(classifyRun(failedUnit, { outcome: "failed", time: "2026-11-01T11:05:00Z", error: "build: exit 1" }, startedMs),
      { outcome: "failed", detail: "build: exit 1" });
    assert.equal(classifyRun(failedUnit, { outcome: "switched", time: "2026-11-01T11:05:00Z" }, startedMs).outcome, "failed");
  });

  it("parseMode defaults to dry-run", () => {
    assert.equal(parseMode("active"), "active");
    assert.equal(parseMode("dry-run"), "dry-run");
    assert.equal(parseMode(undefined), "dry-run");
    assert.equal(parseMode("ACTIVE"), "dry-run");
  });
});

describe("resume decision", () => {
  const base = { me: "n1", currentBootId: "boot-B", unit: inactive, stateFile: null };
  const held = (ann: Record<string, string>, holder = "n1") => lease(holder, "2026-11-01T11:59:00Z", ann);

  it("nothing to resume without a lease, or when someone else holds it", () => {
    assert.deepEqual(decideResume({ ...base, lease: null }), { kind: "none" });
    assert.deepEqual(decideResume({ ...base, lease: held({ [A.PHASE]: "rebooting" }, "n2") }), { kind: "none" });
    assert.deepEqual(decideResume({ ...base, lease: held({}, "") }), { kind: "none" });
  });

  it("held by us with no phase: abandoned (uncordon-if-ours + release)", () => {
    assert.deepEqual(decideResume({ ...base, lease: held({}) }), { kind: "abandoned" });
  });

  it("phase=held stays held", () => {
    assert.deepEqual(decideResume({ ...base, lease: held({ [A.PHASE]: "held", [A.HOLD_REASON]: "drain timed out" }) }),
      { kind: "hold", reason: "drain timed out" });
  });

  it("rebooting with a new boot ID: post-reboot", () => {
    assert.deepEqual(decideResume({ ...base, lease: held({ [A.PHASE]: "rebooting", [A.BOOT_ID]: "boot-A", [A.REBOOT_ATTEMPTS]: "1" }) }),
      { kind: "post-reboot" });
  });

  it("rebooting with the same boot ID: re-issue once, then hold", () => {
    const same = { ...base, currentBootId: "boot-A" };
    assert.deepEqual(decideResume({ ...same, lease: held({ [A.PHASE]: "rebooting", [A.BOOT_ID]: "boot-A", [A.REBOOT_ATTEMPTS]: "1" }) }),
      { kind: "reissue-reboot", attempt: 2 });
    assert.deepEqual(decideResume({ ...same, lease: held({ [A.PHASE]: "rebooting", [A.BOOT_ID]: "boot-A" }) }),
      { kind: "reissue-reboot", attempt: 2 });
    const r = decideResume({ ...same, lease: held({ [A.PHASE]: "rebooting", [A.BOOT_ID]: "boot-A", [A.REBOOT_ATTEMPTS]: "2" }) });
    assert.equal(r.kind, "hold");
  });

  it("upgrading with the unit still running: keep polling", () => {
    assert.deepEqual(decideResume({ ...base, unit: running, lease: held({ [A.PHASE]: "upgrading", [A.STARTED]: STARTED }) }),
      { kind: "poll-unit" });
  });

  it("upgrading with the unit finished: continue from its outcome", () => {
    const lz = held({ [A.PHASE]: "upgrading", [A.STARTED]: STARTED });
    assert.deepEqual(decideResume({ ...base, lease: lz, stateFile: { outcome: "switched", system: "/s", time: "2026-11-01T11:10:00Z" } }),
      { kind: "outcome", outcome: "switched", detail: "/s" });
    assert.deepEqual(decideResume({ ...base, lease: lz, stateFile: { outcome: "reboot-required", system: "/s", time: "2026-11-01T11:10:00Z" } }),
      { kind: "outcome", outcome: "reboot-required", detail: "/s" });
    // node rebooted unexpectedly mid-upgrade: state file (tmpfs) is gone
    assert.equal((decideResume({ ...base, lease: lz }) as { outcome: string }).outcome, "failed");
    // state file left over from an earlier run doesn't count
    assert.equal((decideResume({ ...base, lease: lz, stateFile: { outcome: "switched", time: "2026-10-31T11:10:00Z" } }) as { outcome: string }).outcome, "failed");
  });
});
