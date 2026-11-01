// Tests for the upgrade agent's Ceph logic (host-agent/upgrade-ceph.ts).
//
// Fixtures in fixtures/ceph/ are real output from the ATL1 cluster (Ceph
// 19.2.3, 2026-11-01): `ceph status -f json`, `ceph osd tree -f json`, and
// `ceph osd dump -f json` trimmed to the fields the agent reads. Unhealthy
// cases are derived from them by editing the relevant fields.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCephStatus, parseOsdTree, hostBucketFor, nooutGroups, globalNoout,
  pgStateClean, pgProblems, quorumProblems, cephHostLossProblems, cephHostRecoveryProblems,
} from "../host-agent/upgrade-ceph.js";

type Json = any;
const fixture = (name: string): Json =>
  JSON.parse(readFileSync(new URL(`./fixtures/ceph/${name}`, import.meta.url), "utf8"));

const STATUS = fixture("status.json");
const TREE = fixture("osd-tree.json");
const DUMP = fixture("osd-dump.json");

function treeWith(edit: (nodes: Json[]) => void): Json {
  const t = structuredClone(TREE);
  edit(t.nodes);
  return t;
}
const osdNode = (nodes: Json[], name: string) => nodes.find((n) => n.name === name);

describe("ceph status parsing (live fixture)", () => {
  it("reads quorum, OSD counts and PG states", () => {
    assert.deepEqual(parseCephStatus(STATUS), {
      quorumNames: ["seed-atl1-1", "seed-atl1-2", "seed-atl1-3"],
      numMons: 3,
      numOsds: 3,
      numUpOsds: 3,
      numInOsds: 3,
      numPgs: 81,
      pgsByState: [{ state: "active+clean", count: 81 }],
    });
  });

  it("rejects documents that aren't ceph status", () => {
    assert.throws(() => parseCephStatus({ nodes: [] }));
    assert.throws(() => parseCephStatus(null));
  });
});

describe("ceph osd tree parsing (live fixture)", () => {
  const tree = parseOsdTree(TREE);

  it("finds each node's CRUSH host bucket and its OSDs", () => {
    assert.deepEqual([...tree.hosts.keys()].sort(), ["seed-atl1-1", "seed-atl1-2", "seed-atl1-3"]);
    assert.deepEqual(hostBucketFor(tree, "seed-atl1-1"), { name: "seed-atl1-1", osds: [{ id: 0, name: "osd.0", up: true, in: true }] });
    assert.deepEqual(hostBucketFor(tree, "seed-atl1-3")!.osds.map((o) => o.name), ["osd.2"]);
    assert.equal(tree.osds.length, 3);
  });

  it("no bucket, or a bucket without OSDs, means no noout", () => {
    assert.equal(hostBucketFor(tree, "seed-atl1-9"), null);
    const empty = parseOsdTree(treeWith((nodes) => { osdNode(nodes, "seed-atl1-2").children = []; }));
    assert.equal(hostBucketFor(empty, "seed-atl1-2"), null);
  });

  it("maps status down and reweight 0 to down/out", () => {
    const t = parseOsdTree(treeWith((nodes) => {
      osdNode(nodes, "osd.1").status = "down";
      osdNode(nodes, "osd.2").reweight = 0;
    }));
    assert.deepEqual(t.hosts.get("seed-atl1-2")!.osds[0], { id: 1, name: "osd.1", up: false, in: true });
    assert.deepEqual(t.hosts.get("seed-atl1-3")!.osds[0], { id: 2, name: "osd.2", up: true, in: false });
  });

  it("rejects documents that aren't an osd tree", () => {
    assert.throws(() => parseOsdTree(STATUS));
  });
});

describe("ceph noout flags (osd dump)", () => {
  it("live cluster has none", () => {
    assert.deepEqual(nooutGroups(DUMP), []);
    assert.equal(globalNoout(DUMP), false);
  });

  it("reads host-scoped and global noout", () => {
    const d = structuredClone(DUMP);
    d.crush_node_flags = { "seed-atl1-3": ["noout"], "seed-atl1-1": ["noin"] };
    d.flags_set = [...d.flags_set, "noout"];
    assert.deepEqual(nooutGroups(d), ["seed-atl1-3"]);
    assert.equal(globalNoout(d), true);
    assert.equal(globalNoout({ flags: "noout,sortbitwise" }), true);
  });
});

describe("PG state classification", () => {
  it("only active+clean (optionally scrubbing / snaptrim) is clean", () => {
    for (const ok of ["active+clean", "active+clean+scrubbing", "active+clean+scrubbing+deep", "active+clean+snaptrim"]) {
      assert.equal(pgStateClean(ok), true, ok);
    }
    for (const bad of [
      "active+undersized+degraded", "peering", "active+recovering", "active+remapped+backfilling",
      "active+clean+remapped", "stale+active+clean", "inactive", "unknown", "active+recovery_wait+degraded",
      "active+clean+inconsistent", "down",
    ]) {
      assert.equal(pgStateClean(bad), false, bad);
    }
  });

  it("counts PGs missing from pgs_by_state as unknown", () => {
    const s = parseCephStatus(STATUS);
    assert.deepEqual(pgProblems(s), []);
    assert.deepEqual(pgProblems({ ...s, numPgs: 85 }), ["4 PG(s) in unknown state"]);
  });
});

describe("safe to lose a host", () => {
  const status = parseCephStatus(STATUS);
  const tree = parseOsdTree(TREE);

  it("live cluster: safe", () => {
    assert.deepEqual(cephHostLossProblems(status, tree), []);
  });

  it("an OSD down anywhere: not safe", () => {
    const t = parseOsdTree(treeWith((nodes) => { osdNode(nodes, "osd.1").status = "down"; }));
    assert.deepEqual(cephHostLossProblems({ ...status, numUpOsds: 2 }, t), ["1/3 OSD(s) down", "osd.1 down/in"]);
  });

  it("an OSD out: not safe", () => {
    const t = parseOsdTree(treeWith((nodes) => { osdNode(nodes, "osd.0").reweight = 0; }));
    assert.deepEqual(cephHostLossProblems({ ...status, numInOsds: 2 }, t), ["1/3 OSD(s) out", "osd.0 up/out"]);
  });

  it("degraded / undersized PGs: not safe", () => {
    const s = { ...status, pgsByState: [{ state: "active+clean", count: 60 }, { state: "active+undersized+degraded", count: 21 }] };
    assert.deepEqual(cephHostLossProblems(s, tree), ["21 PG(s) active+undersized+degraded"]);
  });

  it("scrubbing is fine", () => {
    const s = { ...status, pgsByState: [{ state: "active+clean", count: 80 }, { state: "active+clean+scrubbing+deep", count: 1 }] };
    assert.deepEqual(cephHostLossProblems(s, tree), []);
  });

  it("MON quorum 2/3: not safe", () => {
    const s = { ...status, quorumNames: ["seed-atl1-1", "seed-atl1-2"] };
    assert.deepEqual(quorumProblems(s), ["MON quorum 2/3 (seed-atl1-1,seed-atl1-2)"]);
    assert.deepEqual(cephHostLossProblems(s, tree), ["MON quorum 2/3 (seed-atl1-1,seed-atl1-2)"]);
  });
});

describe("recovered after a reboot", () => {
  const status = parseCephStatus(STATUS);

  it("own OSDs up and every PG clean: recovered (noout flag doesn't matter)", () => {
    assert.deepEqual(cephHostRecoveryProblems(status, parseOsdTree(TREE), "seed-atl1-3"), []);
  });

  it("own OSD still down, PGs undersized: not yet", () => {
    const t = parseOsdTree(treeWith((nodes) => { osdNode(nodes, "osd.2").status = "down"; }));
    const s = {
      ...status, numUpOsds: 2,
      quorumNames: ["seed-atl1-1", "seed-atl1-2"],
      pgsByState: [{ state: "active+undersized+degraded", count: 81 }],
    };
    assert.deepEqual(cephHostRecoveryProblems(s, t, "seed-atl1-3"), [
      "osd.2 down/in",
      "MON quorum 2/3 (seed-atl1-1,seed-atl1-2)",
      "81 PG(s) active+undersized+degraded",
    ]);
  });

  it("OSD back up but still peering: not yet", () => {
    const s = { ...status, pgsByState: [{ state: "active+clean", count: 70 }, { state: "peering", count: 11 }] };
    assert.deepEqual(cephHostRecoveryProblems(s, parseOsdTree(TREE), "seed-atl1-3"), ["11 PG(s) peering"]);
  });
});
