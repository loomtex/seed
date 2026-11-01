// Seed host agent — per-node network policy enforcement for instance pods,
// and the node upgrade agent (upgrade.ts).
//
// Runs as a privileged DaemonSet pod (hostNetwork, hostPID). Netpol and the
// upgrade agent are independent: an error in one never stops the other.
// It used to also run swtpm for every instance (SeedHostTask CRDs); the Kata
// shim owns swtpm now, so restarting the host agent no longer touches guest
// TPMs, and the upgrade agent's resume logic covers restarts mid-upgrade.
//
// Netpol iptables rules deliberately outlive this process: shutdown does NOT
// remove them (that used to drop tenant isolation on every host-agent
// restart until the new pod re-applied them). The next pod adopts the
// existing chains (initChains is idempotent, the informer re-list
// re-reconciles each namespace, stale namespace chains are pruned). The only
// teardown path is explicit: starting with SEED_NETPOL_ENABLED unset removes
// any SEED-* chains left behind.

import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig, makeClients, log, sleep } from "../shared/kube.js";
import { startPodWatcher, cleanupAll as cleanupNetpol } from "./netpol.js";
import { startUpgradeAgent } from "./upgrade.js";
import { parseMode } from "./upgrade-logic.js";
import { validTimeZone } from "./upgrade-schedule.js";

const COMPONENT = "host-agent";

async function main(): Promise<void> {
  log(COMPONENT, "starting");

  const kc = loadKubeConfig();
  const clients = makeClients(kc);

  const netpolEnabled = !!process.env.SEED_NETPOL_ENABLED;
  const nodeName = process.env.SEED_NODE_NAME ?? "";

  // Graceful shutdown: leave iptables rules in place (see header).
  const shutdown = () => {
    log(COMPONENT, "shutting down (netpol rules left in place)");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Stay up even with nothing to do, so the DaemonSet pod doesn't restart-loop.
  setInterval(() => {}, 1 << 30);

  // Upgrade agent: runs its own loop and never throws.
  if (!nodeName) {
    log(COMPONENT, "SEED_NODE_NAME not set, upgrade agent disabled");
  } else {
    const tz = validTimeZone(process.env.TZ);
    if (process.env.TZ && tz !== process.env.TZ) log(COMPONENT, `unknown TZ ${process.env.TZ}, using UTC`);
    startUpgradeAgent(kc, { nodeName, mode: parseMode(process.env.SEED_UPGRADE_MODE), tz });
  }

  await startNetpol(kc, clients, netpolEnabled, nodeName);
}

/** Netpol setup; failures are retried here, never propagated to main. */
async function startNetpol(
  kc: k8s.KubeConfig,
  clients: { core: k8s.CoreV1Api },
  enabled: boolean,
  nodeName: string,
): Promise<void> {
  if (!enabled) {
    log(COMPONENT, "SEED_NETPOL_ENABLED not set, removing any leftover netpol chains");
    await cleanupNetpol().catch((err) =>
      log(COMPONENT, `netpol cleanup error: ${err}`),
    );
    return;
  }

  if (!nodeName) {
    log(COMPONENT, "SEED_NODE_NAME required for netpol, skipping");
    return;
  }

  const clusterCidrs = (process.env.SEED_CLUSTER_CIDR ?? "10.42.0.0/16").split(",");
  const serviceCidrs = (process.env.SEED_SERVICE_CIDR ?? "10.43.0.0/16").split(",");
  const dnsIp = process.env.SEED_DNS_IP ?? "10.43.0.10";

  for (;;) {
    try {
      await startPodWatcher(kc, clients, { clusterCidrs, serviceCidrs, dnsIp, nodeName });
      return;
    } catch (err) {
      log(COMPONENT, `netpol start failed, retrying in 10s: ${err}`);
      await sleep(10_000);
    }
  }
}

main().catch((err) => {
  log(COMPONENT, `fatal: ${err}`);
  process.exit(1);
});
