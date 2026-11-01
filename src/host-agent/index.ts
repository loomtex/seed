// Seed host agent — per-node network policy enforcement for instance pods.
//
// Runs as a privileged DaemonSet pod (hostNetwork). It used to also run
// swtpm for every instance (SeedHostTask CRDs); the Kata shim owns swtpm
// now, so restarting the host agent no longer touches guest TPMs.
//
// Netpol iptables rules deliberately outlive this process: shutdown does NOT
// remove them (that used to drop tenant isolation on every host-agent
// restart until the new pod re-applied them). The next pod adopts the
// existing chains (initChains is idempotent, the informer re-list
// re-reconciles each namespace, stale namespace chains are pruned). The only
// teardown path is explicit: starting with SEED_NETPOL_ENABLED unset removes
// any SEED-* chains left behind.

import { loadKubeConfig, makeClients, log } from "../shared/kube.js";
import { startPodWatcher, cleanupAll as cleanupNetpol } from "./netpol.js";

const COMPONENT = "host-agent";

async function main(): Promise<void> {
  log(COMPONENT, "starting");

  const kc = loadKubeConfig();
  const clients = makeClients(kc);

  const netpolEnabled = !!process.env.SEED_NETPOL_ENABLED;

  // Graceful shutdown: leave iptables rules in place (see header).
  const shutdown = () => {
    log(COMPONENT, "shutting down (netpol rules left in place)");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Stay up even with nothing to do, so the DaemonSet pod doesn't restart-loop.
  const idle = () => { setInterval(() => {}, 1 << 30); };

  if (!netpolEnabled) {
    log(COMPONENT, "SEED_NETPOL_ENABLED not set, removing any leftover netpol chains");
    await cleanupNetpol().catch((err) =>
      log(COMPONENT, `netpol cleanup error: ${err}`),
    );
    idle();
    return;
  }

  const clusterCidrs = (process.env.SEED_CLUSTER_CIDR ?? "10.42.0.0/16").split(",");
  const serviceCidrs = (process.env.SEED_SERVICE_CIDR ?? "10.43.0.0/16").split(",");
  const dnsIp = process.env.SEED_DNS_IP ?? "10.43.0.10";
  const nodeName = process.env.SEED_NODE_NAME ?? "";

  if (!nodeName) {
    log(COMPONENT, "SEED_NODE_NAME required for netpol, skipping");
    idle();
    return;
  }

  await startPodWatcher(kc, clients, {
    clusterCidrs,
    serviceCidrs,
    dnsIp,
    nodeName,
  });
}

main().catch((err) => {
  log(COMPONENT, `fatal: ${err}`);
  process.exit(1);
});
