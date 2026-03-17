// Network policy enforcement via iptables.
// Watches seed-managed pods and maintains per-namespace firewall chains.
//
// Chain hierarchy:
//   FORWARD → SEED-FWD (jump at top of FORWARD)
//     → SEED-FWD: conntrack ESTABLISHED/RELATED → ACCEPT
//     → SEED-FWD: per-pod-IP jumps to SEED-NS-<hash> chains
//     → SEED-FWD: known seed pod IP with no namespace match → DROP + LOG
//   SEED-NS-<hash>: per-namespace rules
//     → Allow DNS egress (kube-dns:53)
//     → Allow intra-namespace
//     → Allow exposed port ingress
//     → Allow internet egress (non-cluster CIDRs)
//     → LOG + DROP (default deny)

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import { log } from "../shared/kube.js";
import { LABELS, MANAGED_BY_VALUE, ANNOTATIONS } from "../shared/labels.js";
import type { SeedExposeEntry } from "../shared/types.js";

const COMPONENT = "netpol";
const MAIN_CHAIN = "SEED-FWD";
const EGRESS_CHAIN = "SEED-EGRESS-INET";

interface NetpolConfig {
  clusterCidrs: string[];   // e.g. ["10.42.0.0/16", "fd00::/56"]
  serviceCidrs: string[];   // e.g. ["10.43.0.0/16", "fd01::/108"]
  dnsIp: string;            // e.g. "10.43.0.10"
  nodeName: string;         // filter pods to this node
}

interface PodInfo {
  namespace: string;
  instance: string;
  ips: string[];            // podIPs (IPv4 and/or IPv6)
  exposePorts: ExposedPort[];
}

interface ExposedPort {
  port: number;
  protocols: ("tcp" | "udp")[];
}

// Namespace state: all pods and their info
interface NamespaceState {
  pods: Map<string, PodInfo>;  // keyed by pod UID
}

// Module state
const namespaces = new Map<string, NamespaceState>();
let config: NetpolConfig;

/** Parse expose annotation into ExposedPort list. */
function parseExpose(annotation: string | undefined): ExposedPort[] {
  if (!annotation) return [];
  try {
    const expose: Record<string, SeedExposeEntry> = JSON.parse(annotation);
    return Object.values(expose).map((e) => ({
      port: e.port,
      protocols: e.protocol === "dns"
        ? ["tcp", "udp"] as const
        : e.protocol === "udp"
          ? ["udp"] as const
          : ["tcp"] as const,
    }));
  } catch {
    return [];
  }
}

/** Derive a short chain name from namespace. */
function nsChainName(ns: string): string {
  const hash = createHash("sha256").update(ns).digest("hex").slice(0, 8);
  return `SEED-NS-${hash}`;
}

/** Run iptables with --wait for lock acquisition. */
function ipt(args: string[], ipv6 = false): Promise<{ stdout: string; stderr: string }> {
  const bin = ipv6 ? "/usr/bin/ip6tables" : "/usr/bin/iptables";
  return new Promise((resolve, reject) => {
    execFile(bin, ["--wait", "5", ...args], (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.join(" ")}: ${stderr || err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

/** Check if a chain exists. */
async function chainExists(chain: string, ipv6 = false): Promise<boolean> {
  try {
    await ipt(["-n", "-L", chain], ipv6);
    return true;
  } catch {
    return false;
  }
}

/** Create chain if it doesn't exist. */
async function ensureChain(chain: string, ipv6 = false): Promise<void> {
  if (!(await chainExists(chain, ipv6))) {
    await ipt(["-N", chain], ipv6);
  }
}

/** Check if a jump rule exists in a chain. */
async function jumpExists(chain: string, target: string, ipv6 = false): Promise<boolean> {
  try {
    const { stdout } = await ipt(["-n", "-L", chain], ipv6);
    return stdout.includes(target);
  } catch {
    return false;
  }
}

/** Initialize top-level chains. Called once at startup. */
export async function initChains(cfg: NetpolConfig): Promise<void> {
  config = cfg;

  for (const v6 of [false, true]) {
    // Main chain
    await ensureChain(MAIN_CHAIN, v6);

    // Insert jump from FORWARD if not present
    if (!(await jumpExists("FORWARD", MAIN_CHAIN, v6))) {
      await ipt(["-I", "FORWARD", "1", "-j", MAIN_CHAIN], v6);
    }

    // First rule in SEED-FWD: allow established/related
    // Flush and rebuild to ensure correct order
    await ipt(["-F", MAIN_CHAIN], v6);
    await ipt([
      "-A", MAIN_CHAIN,
      "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED",
      "-j", "ACCEPT",
    ], v6);

    // Internet egress chain (shared across namespaces)
    await ensureChain(EGRESS_CHAIN, v6);
    await ipt(["-F", EGRESS_CHAIN], v6);

    // Block cluster-internal destinations in egress chain
    const cidrs = v6 ? cfg.clusterCidrs.filter(c => c.includes(":")) : cfg.clusterCidrs.filter(c => !c.includes(":"));
    const svcCidrs = v6 ? cfg.serviceCidrs.filter(c => c.includes(":")) : cfg.serviceCidrs.filter(c => !c.includes(":"));
    for (const cidr of [...cidrs, ...svcCidrs]) {
      await ipt(["-A", EGRESS_CHAIN, "-d", cidr, "-j", "RETURN"], v6);
    }
    await ipt(["-A", EGRESS_CHAIN, "-j", "ACCEPT"], v6);
  }

  log(COMPONENT, "iptables chains initialized");
}

/** Rebuild rules for a single namespace. */
async function reconcileNamespace(ns: string): Promise<void> {
  const state = namespaces.get(ns);
  const chain = nsChainName(ns);

  // Collect all pod IPs in this namespace
  const allIps: string[] = [];
  if (state) {
    for (const pod of state.pods.values()) {
      allIps.push(...pod.ips);
    }
  }

  for (const v6 of [false, true]) {
    const ips = allIps.filter((ip) => v6 ? ip.includes(":") : !ip.includes(":"));

    // If no pods for this IP family, clean up chain
    if (ips.length === 0) {
      // Remove jumps from SEED-FWD referencing this chain
      try {
        // List rules, find and delete matching jumps
        const { stdout } = await ipt(["-n", "--line-numbers", "-L", MAIN_CHAIN], v6);
        const lines = stdout.split("\n").reverse(); // delete from bottom up
        for (const line of lines) {
          if (line.includes(chain)) {
            const num = line.match(/^(\d+)/)?.[1];
            if (num) await ipt(["-D", MAIN_CHAIN, num], v6);
          }
        }
      } catch { /* chain may not exist */ }

      // Flush and delete the namespace chain
      if (await chainExists(chain, v6)) {
        await ipt(["-F", chain], v6);
        await ipt(["-X", chain], v6);
      }
      continue;
    }

    // Ensure namespace chain exists
    await ensureChain(chain, v6);
    await ipt(["-F", chain], v6);

    const dnsIp = config.dnsIp;
    const dnsMatch = v6 ? dnsIp.includes(":") : !dnsIp.includes(":");

    for (const ip of ips) {
      // 1. DNS egress — match on original destination (pre-DNAT) since kube-proxy
      // DNATs service IP to real coredns pod IP before the FORWARD chain
      if (dnsMatch) {
        await ipt(["-A", chain, "-s", ip, "-p", "udp", "--dport", "53",
          "-m", "conntrack", "--ctorigdst", dnsIp, "-j", "ACCEPT"], v6);
        await ipt(["-A", chain, "-s", ip, "-p", "tcp", "--dport", "53",
          "-m", "conntrack", "--ctorigdst", dnsIp, "-j", "ACCEPT"], v6);
      }

      // 2. Intra-namespace (src=this pod, dst=any pod in namespace)
      for (const dstIp of ips) {
        if (dstIp !== ip) {
          await ipt(["-A", chain, "-s", ip, "-d", dstIp, "-j", "ACCEPT"], v6);
        }
      }

      // 3. Exposed port ingress
      if (state) {
        for (const pod of state.pods.values()) {
          if (!pod.ips.includes(ip)) continue;
          for (const ep of pod.exposePorts) {
            for (const proto of ep.protocols) {
              await ipt(["-A", chain, "-d", ip, "-p", proto, "--dport", String(ep.port), "-j", "ACCEPT"], v6);
            }
          }
        }
      }

      // 4. Cluster service egress — allow access to service CIDRs (pre-DNAT).
      // This permits reaching services in other namespaces (e.g. seed-system controller)
      // while still blocking direct pod-to-pod cross-namespace traffic.
      // Uses conntrack original dst since kube-proxy DNATs before FORWARD.
      const svcCidrsForFamily = v6
        ? config.serviceCidrs.filter(c => c.includes(":"))
        : config.serviceCidrs.filter(c => !c.includes(":"));
      for (const cidr of svcCidrsForFamily) {
        await ipt(["-A", chain, "-s", ip,
          "-m", "conntrack", "--ctorigdst", cidr, "-j", "ACCEPT"], v6);
      }

      // 5. Internet egress
      await ipt(["-A", chain, "-s", ip, "-j", EGRESS_CHAIN], v6);
    }

    // 6. LOG + DROP (default deny)
    await ipt([
      "-A", chain,
      "-j", "LOG",
      "--log-prefix", `SEED-DROP ${ns.slice(0, 12)}: `,
      "-m", "limit", "--limit", "10/min",
    ], v6);
    await ipt(["-A", chain, "-j", "DROP"], v6);

    // Update SEED-FWD: remove old jumps for this chain, then add new per-IP jumps
    // (jumps must reference specific pod IPs so non-seed traffic passes through)
    try {
      const { stdout } = await ipt(["-n", "--line-numbers", "-L", MAIN_CHAIN], v6);
      const lines = stdout.split("\n").reverse();
      for (const line of lines) {
        if (line.includes(chain)) {
          const num = line.match(/^(\d+)/)?.[1];
          if (num) await ipt(["-D", MAIN_CHAIN, num], v6);
        }
      }
    } catch { /* ok */ }

    // Add per-IP jumps: traffic from OR to a seed pod goes to its namespace chain
    for (const ip of ips) {
      await ipt(["-A", MAIN_CHAIN, "-s", ip, "-j", chain], v6);
      await ipt(["-A", MAIN_CHAIN, "-d", ip, "-j", chain], v6);
    }
  }

  const podCount = state?.pods.size ?? 0;
  log(COMPONENT, `reconciled namespace ${ns}: ${podCount} pods, chain ${chain}`);
}

/** Only enforce policy on tenant namespaces (s-*), not seed-system. */
function isTenantNamespace(ns: string): boolean {
  return ns.startsWith("s-");
}

/** Handle a pod add/update event. */
export function handlePodEvent(pod: k8s.V1Pod): void {
  const uid = pod.metadata?.uid;
  const ns = pod.metadata?.namespace;
  if (!uid || !ns) return;

  // Only enforce policy on tenant namespaces
  if (!isTenantNamespace(ns)) return;

  // Only process pods on this node
  if (pod.spec?.nodeName !== config.nodeName) return;

  // Extract pod IPs
  const ips = (pod.status?.podIPs ?? [])
    .map((p) => p.ip)
    .filter((ip): ip is string => !!ip);

  if (ips.length === 0) return; // pod not yet scheduled or no IP

  const instance = pod.metadata?.labels?.[LABELS.INSTANCE] ?? "";
  const exposeAnnotation = pod.metadata?.annotations?.[ANNOTATIONS.EXPOSE];
  const exposePorts = parseExpose(exposeAnnotation);

  // Get or create namespace state
  let nsState = namespaces.get(ns);
  if (!nsState) {
    nsState = { pods: new Map() };
    namespaces.set(ns, nsState);
  }

  const existing = nsState.pods.get(uid);
  const info: PodInfo = { namespace: ns, instance, ips, exposePorts };

  // Skip if nothing changed
  if (existing && JSON.stringify(existing) === JSON.stringify(info)) return;

  nsState.pods.set(uid, info);

  // Debounce reconciliation — multiple pod events often arrive in bursts
  scheduleReconcile(ns);
}

/** Handle a pod delete event. */
export function handlePodDelete(pod: k8s.V1Pod): void {
  const uid = pod.metadata?.uid;
  const ns = pod.metadata?.namespace;
  if (!uid || !ns) return;

  if (!isTenantNamespace(ns)) return;

  const nsState = namespaces.get(ns);
  if (!nsState) return;

  if (!nsState.pods.has(uid)) return;
  nsState.pods.delete(uid);

  if (nsState.pods.size === 0) {
    namespaces.delete(ns);
  }

  scheduleReconcile(ns);
}

// Debounce timers and serialization locks per namespace
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconcileLocks = new Map<string, Promise<void>>();
const reconcilePending = new Set<string>();

function scheduleReconcile(ns: string): void {
  const existing = reconcileTimers.get(ns);
  if (existing) clearTimeout(existing);

  reconcileTimers.set(
    ns,
    setTimeout(() => {
      reconcileTimers.delete(ns);
      runReconcile(ns);
    }, 500),
  );
}

/** Serialize reconcileNamespace: only one runs at a time per namespace.
 *  If a reconciliation is in progress, mark pending and re-run after. */
function runReconcile(ns: string): void {
  const lock = reconcileLocks.get(ns);
  if (lock) {
    // Already running — mark pending so it re-runs after current finishes
    reconcilePending.add(ns);
    return;
  }

  const p = reconcileNamespace(ns)
    .catch((err) => {
      log(COMPONENT, `reconcile error for ${ns}: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      reconcileLocks.delete(ns);
      if (reconcilePending.has(ns)) {
        reconcilePending.delete(ns);
        runReconcile(ns);
      }
    });

  reconcileLocks.set(ns, p);
}

/** Remove all SEED-* chains and rules. Called on shutdown. */
export async function cleanupAll(): Promise<void> {
  for (const v6 of [false, true]) {
    // Remove jump from FORWARD
    try {
      const { stdout } = await ipt(["-n", "--line-numbers", "-L", "FORWARD"], v6);
      const lines = stdout.split("\n").reverse();
      for (const line of lines) {
        if (line.includes(MAIN_CHAIN)) {
          const num = line.match(/^(\d+)/)?.[1];
          if (num) await ipt(["-D", "FORWARD", num], v6);
        }
      }
    } catch { /* ok */ }

    // Flush and delete SEED-FWD
    if (await chainExists(MAIN_CHAIN, v6)) {
      await ipt(["-F", MAIN_CHAIN], v6);
      await ipt(["-X", MAIN_CHAIN], v6);
    }

    // Flush and delete all SEED-NS-* chains
    for (const ns of namespaces.keys()) {
      const chain = nsChainName(ns);
      if (await chainExists(chain, v6)) {
        await ipt(["-F", chain], v6);
        await ipt(["-X", chain], v6);
      }
    }

    // Flush and delete egress chain
    if (await chainExists(EGRESS_CHAIN, v6)) {
      await ipt(["-F", EGRESS_CHAIN], v6);
      await ipt(["-X", EGRESS_CHAIN], v6);
    }
  }

  log(COMPONENT, "all iptables chains cleaned up");
}

/** Start the pod informer for network policy. */
export async function startPodWatcher(
  kc: k8s.KubeConfig,
  clients: { core: k8s.CoreV1Api },
  cfg: NetpolConfig,
): Promise<void> {
  await initChains(cfg);

  const labelSelector = `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`;

  const listFn = async () =>
    clients.core.listPodForAllNamespaces({ labelSelector });

  const informer = k8s.makeInformer<k8s.V1Pod>(
    kc,
    "/api/v1/pods",
    listFn,
    labelSelector,
  );

  informer.on("add", handlePodEvent);
  informer.on("update", handlePodEvent);
  informer.on("delete", handlePodDelete);
  informer.on("error", (err) => {
    log(COMPONENT, `pod informer error: ${err}`);
  });

  await informer.start();
  log(COMPONENT, `watching pods on node ${cfg.nodeName}`);
}
