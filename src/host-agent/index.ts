// Seed host agent — watches SeedHostTask CRDs and manages host-level
// processes (swtpm) that must run outside of Kata VMs.
//
// Runs as a privileged DaemonSet pod with hostPath mounts to:
//   /var/lib/seed-controller/tpm/  (persistent TPM state)
//   /run/swtpm/                    (ephemeral sockets)

import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig, makeClients, log } from "../shared/kube.js";
import type { SeedHostTask } from "../shared/types.js";
import { ensureSwtpm, stopSwtpm, stopAll } from "./swtpm.js";

const COMPONENT = "host-agent";
const CRD_GROUP = "seed.loom.farm";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "seedhosttasks";

async function main(): Promise<void> {
  log(COMPONENT, "starting");

  const kc = loadKubeConfig();
  const clients = makeClients(kc);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(COMPONENT, "shutting down, killing all swtpm processes");
    stopAll();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await watchHostTasks(kc, clients);
}

async function watchHostTasks(
  kc: k8s.KubeConfig,
  clients: ReturnType<typeof makeClients>,
): Promise<void> {
  const listFn = async (): Promise<k8s.KubernetesListObject<SeedHostTask>> =>
    clients.custom.listClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CRD_PLURAL,
    }) as Promise<k8s.KubernetesListObject<SeedHostTask>>;

  const informer = k8s.makeInformer<SeedHostTask>(
    kc,
    `/apis/${CRD_GROUP}/${CRD_VERSION}/${CRD_PLURAL}`,
    listFn,
  );

  informer.on("add", (obj) => handleTask(clients, obj));
  informer.on("update", (obj) => handleTask(clients, obj));
  informer.on("delete", (obj) => handleDelete(obj));
  informer.on("error", (err) => {
    log(COMPONENT, `informer error: ${err}`);
    // Informer auto-reconnects
  });

  await informer.start();
  log(COMPONENT, "watching SeedHostTask CRDs");
}

async function handleTask(
  clients: ReturnType<typeof makeClients>,
  task: SeedHostTask,
): Promise<void> {
  const name = task.metadata?.name;
  if (!name) return;

  const { type, instance, namespace: ns } = task.spec;

  // Already ready? Skip.
  if (task.status?.ready) return;

  if (type !== "swtpm") {
    log(COMPONENT, `unknown task type "${type}", skipping`, name);
    await updateStatus(clients, task, {
      ready: false,
      socketPath: "",
      message: `unknown task type: ${type}`,
    });
    return;
  }

  log(COMPONENT, `handling swtpm task for ${ns}/${instance}`, name);

  const socketPath = await ensureSwtpm(ns, instance);
  if (socketPath) {
    await updateStatus(clients, task, {
      ready: true,
      socketPath,
      message: "swtpm running",
    });
  } else {
    await updateStatus(clients, task, {
      ready: false,
      socketPath: "",
      message: "swtpm failed to start",
    });
  }
}

async function handleDelete(task: SeedHostTask): Promise<void> {
  const name = task.metadata?.name;
  if (!name) return;

  const { type, instance, namespace: ns } = task.spec;
  if (type !== "swtpm") return;

  log(COMPONENT, `task deleted, stopping swtpm for ${ns}/${instance}`, name);
  await stopSwtpm(ns, instance);
}

async function updateStatus(
  clients: ReturnType<typeof makeClients>,
  task: SeedHostTask,
  status: SeedHostTask["status"],
): Promise<void> {
  const name = task.metadata?.name;
  const ns = task.metadata?.namespace;
  if (!name) return;

  try {
    // SeedHostTask is cluster-scoped (no namespace on the CRD itself),
    // but if it has a namespace, use namespaced API. Check which applies.
    if (ns) {
      await clients.custom.patchNamespacedCustomObjectStatus({
        group: CRD_GROUP,
        version: CRD_VERSION,
        plural: CRD_PLURAL,
        namespace: ns,
        name,
        body: { status },
      });
    } else {
      await clients.custom.patchClusterCustomObjectStatus({
        group: CRD_GROUP,
        version: CRD_VERSION,
        plural: CRD_PLURAL,
        name,
        body: { status },
      });
    }
    log(COMPONENT, `status updated: ready=${status?.ready}`, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(COMPONENT, `failed to update status: ${msg}`, name);
  }
}

main().catch((err) => {
  log(COMPONENT, `fatal: ${err}`);
  process.exit(1);
});
