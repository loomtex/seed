// Upgrade agent — Ceph decisions (pure). Parses `ceph status -f json`,
// `ceph osd tree -f json` and `ceph osd dump -f json`, and decides whether
// the cluster can lose this host for a reboot / has recovered after one.
//
// Never keyed off health.status: our own host-scoped noout makes the cluster
// HEALTH_WARN (OSD_FLAGS) for the whole reboot. The checks are explicit.

export interface PgStateCount {
  state: string;
  count: number;
}

export interface CephStatus {
  quorumNames: string[];
  numMons: number;
  numOsds: number;
  numUpOsds: number;
  numInOsds: number;
  numPgs: number;
  pgsByState: PgStateCount[];
}

export interface CephOsd {
  id: number;
  name: string;
  up: boolean;
  in: boolean;
}

export interface CephHost {
  name: string;
  osds: CephOsd[];
}

export interface CephTree {
  /** CRUSH host buckets by name. */
  hosts: Map<string, CephHost>;
  /** Every OSD in the tree (incl. ones not under a host bucket). */
  osds: CephOsd[];
}

type Json = any;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseCephStatus(j: Json): CephStatus {
  if (!j || typeof j !== "object" || !j.osdmap || !j.pgmap) throw new Error("not a `ceph status -f json` document");
  // Ceph ≥ 15 nests osdmap one level deeper in some releases; accept both.
  const osdmap = j.osdmap.osdmap ?? j.osdmap;
  return {
    quorumNames: Array.isArray(j.quorum_names) ? j.quorum_names.map(String) : [],
    numMons: num(j.monmap?.num_mons) || (Array.isArray(j.monmap?.mons) ? j.monmap.mons.length : 0),
    numOsds: num(osdmap.num_osds),
    numUpOsds: num(osdmap.num_up_osds),
    numInOsds: num(osdmap.num_in_osds),
    numPgs: num(j.pgmap.num_pgs),
    pgsByState: (Array.isArray(j.pgmap.pgs_by_state) ? j.pgmap.pgs_by_state : [])
      .map((s: Json) => ({ state: String(s.state_name ?? ""), count: num(s.count) })),
  };
}

export function parseOsdTree(j: Json): CephTree {
  if (!j || !Array.isArray(j.nodes)) throw new Error("not a `ceph osd tree -f json` document");
  const byId = new Map<number, Json>();
  for (const n of j.nodes) byId.set(n.id, n);
  const toOsd = (n: Json): CephOsd => ({
    id: n.id,
    name: String(n.name),
    up: n.status === "up",
    // reweight 0 = out
    in: num(n.reweight) > 0,
  });
  const osds = [...j.nodes, ...(Array.isArray(j.stray) ? j.stray : [])]
    .filter((n: Json) => n.type === "osd")
    .map(toOsd);
  const hosts = new Map<string, CephHost>();
  for (const n of j.nodes) {
    if (n.type !== "host") continue;
    const children: number[] = Array.isArray(n.children) ? n.children : [];
    hosts.set(String(n.name), {
      name: String(n.name),
      osds: children.map((id) => byId.get(id)).filter((c: Json) => c?.type === "osd").map(toOsd),
    });
  }
  return { hosts, osds };
}

/** CRUSH host bucket for a node (named after it), only if it holds OSDs. */
export function hostBucketFor(tree: CephTree, nodeName: string): CephHost | null {
  const h = tree.hosts.get(nodeName);
  return h && h.osds.length > 0 ? h : null;
}

/** Crush nodes (hosts) with the noout flag set, from `ceph osd dump -f json`. */
export function nooutGroups(dump: Json): string[] {
  const flags = dump?.crush_node_flags ?? {};
  return Object.keys(flags).filter((k) => Array.isArray(flags[k]) && flags[k].includes("noout")).sort();
}

/** Cluster-wide noout (`ceph osd set noout`), from `ceph osd dump -f json`. */
export function globalNoout(dump: Json): boolean {
  const set: unknown = dump?.flags_set;
  if (Array.isArray(set)) return set.includes("noout");
  return typeof dump?.flags === "string" && dump.flags.split(",").includes("noout");
}

/**
 * PG state tokens that are fine: active+clean, optionally scrubbing or
 * trimming snapshots. Anything else (degraded, undersized, peering,
 * backfill*, recover*, remapped, stale, down, incomplete, inconsistent,
 * unknown, ...) counts as not clean.
 */
const BENIGN_PG_TOKENS = new Set(["active", "clean", "scrubbing", "deep", "snaptrim", "snaptrim_wait"]);

export function pgStateClean(state: string): boolean {
  const tokens = state.split("+");
  return tokens.includes("active") && tokens.includes("clean") && tokens.every((t) => BENIGN_PG_TOKENS.has(t));
}

export function pgProblems(s: CephStatus): string[] {
  const bad = s.pgsByState.filter((p) => p.count > 0 && !pgStateClean(p.state));
  const problems = bad.map((p) => `${p.count} PG(s) ${p.state}`);
  const counted = s.pgsByState.reduce((a, p) => a + p.count, 0);
  if (counted < s.numPgs) problems.push(`${s.numPgs - counted} PG(s) in unknown state`);
  return problems;
}

export function quorumProblems(s: CephStatus): string[] {
  if (s.numMons === 0) return ["no MONs in monmap"];
  return s.quorumNames.length < s.numMons
    ? [`MON quorum ${s.quorumNames.length}/${s.numMons} (${s.quorumNames.join(",") || "none"})`]
    : [];
}

function osdProblems(s: CephStatus, osds: CephOsd[]): string[] {
  const problems: string[] = [];
  if (s.numUpOsds < s.numOsds) problems.push(`${s.numOsds - s.numUpOsds}/${s.numOsds} OSD(s) down`);
  if (s.numInOsds < s.numOsds) problems.push(`${s.numOsds - s.numInOsds}/${s.numOsds} OSD(s) out`);
  for (const o of osds) {
    if (!o.up || !o.in) problems.push(`${o.name} ${o.up ? "up" : "down"}/${o.in ? "in" : "out"}`);
  }
  return problems;
}

/**
 * Can the cluster lose `nodeName` for a reboot? All OSDs up and in, every PG
 * active+clean, full MON quorum. Empty list = safe.
 */
export function cephHostLossProblems(s: CephStatus, tree: CephTree): string[] {
  return [...quorumProblems(s), ...osdProblems(s, tree.osds), ...pgProblems(s)];
}

/**
 * After this node rebooted: its OSDs are up (and in), every PG active+clean
 * and MON quorum is full again. Empty list = recovered.
 */
export function cephHostRecoveryProblems(s: CephStatus, tree: CephTree, nodeName: string): string[] {
  const host = tree.hosts.get(nodeName);
  const mine = host ? host.osds : [];
  const problems = mine
    .filter((o) => !o.up || !o.in)
    .map((o) => `${o.name} ${o.up ? "up" : "down"}/${o.in ? "in" : "out"}`);
  return [...problems, ...quorumProblems(s), ...pgProblems(s)];
}
