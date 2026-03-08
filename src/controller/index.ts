// Seed controller — main reconciliation engine.
//
// Multi-flake support: reconciles N flakes, each in its own namespace
// with its own generation hash. Event-driven reconciliation:
// - On startup: reconcile all flakes (skip unchanged via commit hash)
// - On webhook: reconcile only the flake that was pushed
// - Watch-based drift correction: cluster-wide watches detect changes
//
// Instances are managed as Deployments (replicas=1, strategy=Recreate).
// k8s handles pod replacement, restart, and health.

import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig, makeClients, deriveNamespace, computeGeneration, log, sleep, applyResource, applyDeployment } from "../shared/kube.js";
import { LABELS, MANAGED_BY_VALUE, MANAGED_SELECTOR, ANNOTATIONS, seedLabels } from "../shared/labels.js";
import type { ControllerConfig, DesiredState, InstanceState, IPv4Config, IPv6Config, SeedHostTask, BuildResult } from "../shared/types.js";
import { generateDeployment, generatePVC, generateService, generateHostTask } from "./manifests.js";
import { generateIPv4Services, generateIPv6Services } from "./routes.js";
import { configureMetalLB } from "./metallb.js";
import { runBuilders } from "./builder.js";
import { startWebhookServer } from "./webhook.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- Per-flake state ---

interface FlakeState {
  flakePath: string;
  namespace: string;
  desired: DesiredState | null;
  reconciling: boolean;
}

// --- Configuration ---

function loadConfig(): ControllerConfig {
  const flakePathsRaw = process.env["SEED_FLAKE_PATHS"];
  if (!flakePathsRaw) throw new Error("SEED_FLAKE_PATHS must be set");

  const flakePaths = flakePathsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (flakePaths.length === 0) throw new Error("SEED_FLAKE_PATHS must contain at least one path");

  return {
    flakePaths,
    ipv4Address: process.env["SEED_IPV4_ADDRESS"] || "",
    ipv6Block: process.env["SEED_IPV6_BLOCK"] || "",
    webhookSecretFile: process.env["SEED_WEBHOOK_SECRET_FILE"] || "",
    builderImage: process.env["SEED_BUILDER_IMAGE"] || "",
    swtpmEnabled: !!process.env["SEED_SWTPM_ENABLED"],
  };
}

// --- Nix helpers ---

/** List instance names from the flake. */
async function listInstances(
  flakePath: string,
  refresh: boolean,
): Promise<string[]> {
  const args = [
    "eval",
    `${flakePath}#seeds`,
    "--apply",
    "builtins.attrNames",
    "--json",
  ];
  if (refresh) args.push("--refresh");

  const { stdout } = await execFileAsync("nix", args, { timeout: 120_000 });
  return JSON.parse(stdout) as string[];
}

/** Evaluate a nix expression to JSON. */
async function nixEvalJson(
  expr: string,
  refresh: boolean,
): Promise<unknown> {
  const args = ["eval", expr, "--json"];
  if (refresh) args.push("--refresh");

  const { stdout } = await execFileAsync("nix", args, { timeout: 120_000 });
  return JSON.parse(stdout);
}

/** Build a nix derivation and return the output path. */
async function nixBuild(
  expr: string,
  refresh: boolean,
): Promise<string> {
  const args = ["build", expr, "--no-link", "--print-out-paths"];
  if (refresh) args.push("--refresh");

  const { stdout } = await execFileAsync("nix", args, { timeout: 600_000 });
  return stdout.trim();
}

/** Get the git revision of a flake (fast, no build). */
async function getFlakeRevision(flakePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "nix",
      ["flake", "metadata", flakePath, "--json"],
      { timeout: 30_000 },
    );
    const meta = JSON.parse(stdout);
    return meta.revision || null;
  } catch {
    return null;
  }
}

// --- Reconciliation ---

/**
 * Build desired state from build results and route configs.
 */
export function renderDesiredState(
  namespace: string,
  swtpmEnabled: boolean,
  ipv4Address: string,
  buildResults: Map<string, BuildResult>,
  ipv4Config: IPv4Config | null,
  ipv6Config: IPv6Config | null,
  hostTaskStatuses: Map<string, { ready: boolean; socketPath: string }>,
): DesiredState {
  const generation = computeGeneration(
    new Map([...buildResults].map(([name, r]) => [name, r.imagePath])),
  );

  const instances = new Map<string, InstanceState>();

  for (const [name, result] of buildResults) {
    const imageRef = `nix:0${result.imagePath}`;
    const { meta } = result;

    // Check for TPM socket from host agent
    let tpmSocketPath: string | undefined;
    if (swtpmEnabled) {
      const status = hostTaskStatuses.get(name);
      if (status?.ready) {
        tpmSocketPath = status.socketPath;
      }
    }

    const deployment = generateDeployment(
      name,
      imageRef,
      generation,
      namespace,
      meta,
      tpmSocketPath,
    );

    const services: k8s.V1Service[] = [];
    const svc = generateService(name, generation, namespace, meta);
    if (svc) services.push(svc);

    const pvcs: k8s.V1PersistentVolumeClaim[] = [];
    for (const [key, entry] of Object.entries(meta.storage)) {
      pvcs.push(generatePVC(name, key, entry.size, generation, namespace));
    }

    // TPM identity PVC
    if (swtpmEnabled) {
      pvcs.push(generatePVC(name, "tpm-identity", "10Mi", generation, namespace));
    }

    const hostTask = swtpmEnabled
      ? generateHostTask(name, namespace, generation)
      : null;

    instances.set(name, { imagePath: result.imagePath, meta, deployment, services, pvcs, hostTask });
  }

  // Route services
  const ipv4Services = ipv4Config
    ? generateIPv4Services(ipv4Config, ipv4Address, generation, namespace)
    : [];
  const ipv6Services = ipv6Config
    ? generateIPv6Services(ipv6Config, generation, namespace)
    : [];

  return {
    generation,
    namespace,
    instances,
    routes: { ipv4: ipv4Services, ipv6: ipv6Services },
  };
}

/**
 * Apply SeedHostTasks for all instances.
 * Called before rendering deployments so the host-agent can start swtpm processes.
 */
async function applySeedHostTasks(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
  buildResults: Map<string, BuildResult>,
  generation: string,
): Promise<void> {
  for (const [name] of buildResults) {
    const hostTask = generateHostTask(name, namespace, generation);
    try {
      const existing = await clients.custom.getNamespacedCustomObject({
        group: "seed.loom.farm",
        version: "v1alpha1",
        namespace,
        plural: "seedhosttasks",
        name: hostTask.metadata!.name!,
      }) as SeedHostTask;
      const existingGen = existing.metadata?.labels?.[LABELS.GENERATION];
      if (existingGen !== generation) {
        existing.metadata = existing.metadata || {};
        existing.metadata.labels = {
          ...existing.metadata.labels,
          [LABELS.GENERATION]: generation,
        };
        await clients.custom.replaceNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seedhosttasks",
          name: hostTask.metadata!.name!,
          body: existing,
        });
        log("controller", `updated SeedHostTask swtpm-${name} generation`, name);
      } else {
        log("controller", `SeedHostTask swtpm-${name} up to date`, name);
      }
    } catch {
      await clients.custom.createNamespacedCustomObject({
        group: "seed.loom.farm",
        version: "v1alpha1",
        namespace,
        plural: "seedhosttasks",
        body: hostTask,
      });
      log("controller", `created SeedHostTask swtpm-${name}`, name);
    }
  }
}

/**
 * Wait for all SeedHostTasks to become ready.
 * Polls every 2s, up to 60s total. Logs progress.
 */
async function waitForHostTasks(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
  buildResults: Map<string, BuildResult>,
  generation: string,
): Promise<void> {
  const expectedTasks = new Set([...buildResults.keys()].map((n) => `swtpm-${n}`));
  const maxWait = 60_000;
  const pollInterval = 2_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const statuses = await readHostTaskStatuses(clients, namespace);
    let allReady = true;
    for (const name of buildResults.keys()) {
      const status = statuses.get(name);
      if (!status?.ready) {
        allReady = false;
        break;
      }
    }
    if (allReady) {
      log("controller", "all SeedHostTasks ready");
      return;
    }
    await sleep(pollInterval);
  }

  // Not all ready after timeout — proceed anyway (deployments will lack TPM)
  log("controller", "warning: some SeedHostTasks not ready after 60s, proceeding without TPM");
}

/**
 * Apply the desired state to the cluster.
 * Creates missing resources, updates existing ones.
 */
async function applyDesiredState(
  clients: ReturnType<typeof makeClients>,
  desired: DesiredState,
): Promise<void> {
  const { namespace } = desired;

  // Apply SeedHostTasks first (swtpm must be running before pods start)
  for (const [name, instance] of desired.instances) {
    if (instance.hostTask) {
      try {
        const existing = await clients.custom.getNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seedhosttasks",
          name: instance.hostTask.metadata!.name!,
        }) as SeedHostTask;
        // Update generation label if changed
        const existingGen = existing.metadata?.labels?.[LABELS.GENERATION];
        if (existingGen !== desired.generation) {
          existing.metadata = existing.metadata || {};
          existing.metadata.labels = {
            ...existing.metadata.labels,
            [LABELS.GENERATION]: desired.generation,
          };
          await clients.custom.replaceNamespacedCustomObject({
            group: "seed.loom.farm",
            version: "v1alpha1",
            namespace,
            plural: "seedhosttasks",
            name: instance.hostTask.metadata!.name!,
            body: existing,
          });
          log("controller", `updated SeedHostTask swtpm-${name} generation`, name);
        } else {
          log("controller", `SeedHostTask swtpm-${name} up to date`, name);
        }
      } catch {
        await clients.custom.createNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seedhosttasks",
          body: instance.hostTask,
        });
        log("controller", `created SeedHostTask swtpm-${name}`, name);
      }
    }
  }

  // Apply PVCs (before deployments, so volumes are available)
  for (const [name, instance] of desired.instances) {
    for (const pvc of instance.pvcs) {
      try {
        await applyResource(clients.core, "PersistentVolumeClaim", namespace, pvc);
        log("controller", `applied PVC ${pvc.metadata!.name}`, name);
      } catch (err) {
        log("controller", `PVC ${pvc.metadata!.name} error: ${err}`, name);
      }
    }
  }

  // Apply Deployments — k8s handles pod replacement on spec change
  for (const [name, instance] of desired.instances) {
    try {
      await applyDeployment(clients.apps, namespace, instance.deployment);
      log("controller", `applied deployment seed-${name}`, name);
    } catch (err) {
      log("controller", `deployment error: ${err}`, name);
    }
  }

  // Apply services (ClusterIP)
  for (const [name, instance] of desired.instances) {
    for (const svc of instance.services) {
      try {
        await applyResource(clients.core, "Service", namespace, svc);
        log("controller", `applied service ${svc.metadata!.name}`, name);
      } catch (err) {
        log("controller", `service error: ${err}`, name);
      }
    }
  }

  // Apply route services (LoadBalancer)
  for (const svc of [...desired.routes.ipv4, ...desired.routes.ipv6]) {
    try {
      await applyResource(clients.core, "Service", namespace, svc);
      log("controller", `applied route service ${svc.metadata!.name}`);
    } catch (err) {
      log("controller", `route service error: ${err}`);
    }
  }
}

/**
 * Reap resources whose generation doesn't match.
 * PVCs are never reaped — delete manually if needed.
 */
async function reapOldResources(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
  generation: string,
): Promise<void> {
  // Reap old Deployments
  try {
    const deployments = await clients.apps.listNamespacedDeployment({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const dep of deployments.items) {
      const depGen = dep.metadata?.labels?.[LABELS.GENERATION];
      if (depGen && depGen !== generation) {
        log("controller", `reaping deployment: ${dep.metadata!.name}`);
        await clients.apps.deleteNamespacedDeployment({
          name: dep.metadata!.name!,
          namespace,
        });
      }
    }
  } catch (err) {
    log("controller", `error reaping deployments: ${err}`);
  }

  // Reap old services
  try {
    const svcs = await clients.core.listNamespacedService({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const svc of svcs.items) {
      const svcGen = svc.metadata?.labels?.[LABELS.GENERATION];
      if (svcGen && svcGen !== generation) {
        log("controller", `reaping service: ${svc.metadata!.name}`);
        await clients.core.deleteNamespacedService({
          name: svc.metadata!.name!,
          namespace,
        });
      }
    }
  } catch (err) {
    log("controller", `error reaping services: ${err}`);
  }

  // Reap old SeedHostTasks
  try {
    const tasks = await clients.custom.listNamespacedCustomObject({
      group: "seed.loom.farm",
      version: "v1alpha1",
      namespace,
      plural: "seedhosttasks",
    }) as { items: SeedHostTask[] };
    for (const task of tasks.items) {
      const taskGen = task.metadata?.labels?.[LABELS.GENERATION];
      if (taskGen && taskGen !== generation) {
        log("controller", `reaping SeedHostTask: ${task.metadata!.name}`);
        await clients.custom.deleteNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seedhosttasks",
          name: task.metadata!.name!,
        });
      }
    }
  } catch (err) {
    log("controller", `error reaping SeedHostTasks: ${err}`);
  }

  // PVCs are never reaped
}

/**
 * Read SeedHostTask statuses from the cluster.
 */
async function readHostTaskStatuses(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
): Promise<Map<string, { ready: boolean; socketPath: string }>> {
  const statuses = new Map<string, { ready: boolean; socketPath: string }>();
  try {
    const result = await clients.custom.listNamespacedCustomObject({
      group: "seed.loom.farm",
      version: "v1alpha1",
      namespace,
      plural: "seedhosttasks",
    }) as { items: SeedHostTask[] };

    for (const task of result.items) {
      if (task.status && task.spec.instance) {
        statuses.set(task.spec.instance, {
          ready: task.status.ready,
          socketPath: task.status.socketPath,
        });
      }
    }
  } catch {
    // CRD might not exist yet
  }
  return statuses;
}

/**
 * Get the generation currently deployed (from any seed-managed Deployment).
 */
async function deployedGeneration(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
): Promise<string> {
  try {
    const deployments = await clients.apps.listNamespacedDeployment({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const dep of deployments.items) {
      const gen = dep.metadata?.labels?.[LABELS.GENERATION];
      if (gen) return gen;
    }
  } catch {
    // Namespace or deployments might not exist yet
  }
  return "";
}

/**
 * Read the commit annotation from a namespace.
 */
async function getDeployedCommit(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
): Promise<string> {
  try {
    const ns = await clients.core.readNamespace({ name: namespace });
    return ns.metadata?.annotations?.[ANNOTATIONS.COMMIT] || "";
  } catch {
    return "";
  }
}

/**
 * Set the commit annotation on a namespace.
 */
async function setDeployedCommit(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
  commit: string,
): Promise<void> {
  try {
    const ns = await clients.core.readNamespace({ name: namespace });
    ns.metadata = ns.metadata || {};
    ns.metadata.annotations = {
      ...ns.metadata.annotations,
      [ANNOTATIONS.COMMIT]: commit,
    };
    await clients.core.replaceNamespace({ name: namespace, body: ns });
  } catch (err) {
    log("controller", `failed to set commit annotation on ${namespace}: ${err}`);
  }
}

/**
 * Load existing desired state from cluster resources.
 * Used for unchanged flakes to populate the watch drift-correction state.
 */
async function loadExistingDesired(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
): Promise<DesiredState | null> {
  const generation = await deployedGeneration(clients, namespace);
  if (!generation) return null;

  const instances = new Map<string, InstanceState>();

  // Load deployments
  try {
    const deployments = await clients.apps.listNamespacedDeployment({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const dep of deployments.items) {
      const instanceName = dep.metadata?.labels?.[LABELS.INSTANCE];
      if (!instanceName) continue;
      // Create a minimal InstanceState with the deployment
      instances.set(instanceName, {
        imagePath: "",
        meta: { name: instanceName, system: "", size: "", resources: { vcpus: 0, memory: 0 }, expose: {}, storage: {}, connect: {} },
        deployment: dep,
        services: [],
        pvcs: [],
        hostTask: null,
      });
    }
  } catch {
    // No deployments
  }

  // Load services into instances
  try {
    const svcs = await clients.core.listNamespacedService({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const svc of svcs.items) {
      const instanceName = svc.metadata?.labels?.[LABELS.INSTANCE];
      const serviceType = svc.metadata?.labels?.[LABELS.SERVICE_TYPE];
      if (serviceType) continue; // Route services handled below
      if (instanceName && instances.has(instanceName)) {
        instances.get(instanceName)!.services.push(svc);
      }
    }
  } catch {
    // No services
  }

  // Load route services
  const ipv4Routes: k8s.V1Service[] = [];
  const ipv6Routes: k8s.V1Service[] = [];
  try {
    const svcs = await clients.core.listNamespacedService({
      namespace,
      labelSelector: `${LABELS.SERVICE_TYPE}`,
    });
    for (const svc of svcs.items) {
      const st = svc.metadata?.labels?.[LABELS.SERVICE_TYPE];
      if (st === "ipv4") ipv4Routes.push(svc);
      else if (st === "ipv6") ipv6Routes.push(svc);
    }
  } catch {
    // No route services
  }

  return {
    generation,
    namespace,
    instances,
    routes: { ipv4: ipv4Routes, ipv6: ipv6Routes },
  };
}

// --- Watch-based drift correction ---

/**
 * Start k8s API watches on managed Deployments and Services across all namespaces.
 * On any change or deletion, compare against desired state and re-apply if drifted.
 *
 * Uses `makeInformer` which handles automatic reconnection on watch errors.
 *
 * Drift detection uses k8s `metadata.generation` — a counter incremented only
 * on spec changes (not status updates). We track the last-seen generation per
 * resource. When a watch event arrives with the same generation, it's a status
 * update (or our own change) and can be skipped. When generation changes,
 * someone edited the spec externally and we re-apply.
 */
function startWatches(
  kc: k8s.KubeConfig,
  clients: ReturnType<typeof makeClients>,
  flakeStates: Map<string, FlakeState>,
  namespaceToFlake: Map<string, string>,
): void {
  // Track k8s metadata.generation per resource to detect spec-only changes.
  // Status updates don't increment metadata.generation, so they're filtered out.
  const knownGeneration = new Map<string, number>();

  /** Look up the FlakeState for a given k8s namespace. */
  function getFlakeStateForNamespace(ns: string): FlakeState | null {
    const flakePath = namespaceToFlake.get(ns);
    if (!flakePath) return null;
    return flakeStates.get(flakePath) || null;
  }

  // --- Deployment watch (all namespaces) ---

  const deploymentInformer = k8s.makeInformer<k8s.V1Deployment>(
    kc,
    `/apis/apps/v1/deployments`,
    () => clients.apps.listDeploymentForAllNamespaces({
      labelSelector: MANAGED_SELECTOR,
    }) as Promise<k8s.KubernetesListObject<k8s.V1Deployment>>,
    MANAGED_SELECTOR,
  );

  async function handleDeploymentChange(obj: k8s.V1Deployment): Promise<void> {
    const name = obj.metadata?.name;
    const ns = obj.metadata?.namespace;
    if (!name || !ns) return;

    const fs = getFlakeStateForNamespace(ns);
    if (!fs) return; // Not our namespace

    const key = `deployment/${ns}/${name}`;
    const gen = obj.metadata?.generation;

    // Always track generation, even during reconciliation
    if (gen !== undefined && knownGeneration.get(key) === gen) return;
    if (gen !== undefined) knownGeneration.set(key, gen);

    // Only correct drift outside of reconciliation
    if (fs.reconciling) return;

    if (!fs.desired) return;

    const desiredDep = findDesiredDeployment(fs.desired, name);
    if (!desiredDep) return;

    try {
      await applyDeployment(clients.apps, ns, desiredDep);
      log("controller", `watch: corrected spec drift on deployment ${name}`);
    } catch (err) {
      log("controller", `watch: failed to correct deployment ${name}: ${err}`);
    }
  }

  async function handleDeploymentDelete(obj: k8s.V1Deployment): Promise<void> {
    const name = obj.metadata?.name;
    const ns = obj.metadata?.namespace;
    if (!name || !ns) return;

    const fs = getFlakeStateForNamespace(ns);
    if (!fs) return;

    knownGeneration.delete(`deployment/${ns}/${name}`);
    if (fs.reconciling) return;

    if (!fs.desired) return;

    const desiredDep = findDesiredDeployment(fs.desired, name);
    if (!desiredDep) return;

    log("controller", `watch: recreating deleted deployment ${name}`);
    try {
      await applyDeployment(clients.apps, ns, desiredDep);
    } catch (err) {
      log("controller", `watch: failed to recreate deployment ${name}: ${err}`);
    }
  }

  // Seed the known generation on initial list to avoid false drift on startup
  deploymentInformer.on("add", (obj) => {
    const name = obj.metadata?.name;
    const ns = obj.metadata?.namespace;
    const gen = obj.metadata?.generation;
    if (name && ns && gen !== undefined) knownGeneration.set(`deployment/${ns}/${name}`, gen);
  });
  deploymentInformer.on("update", (obj) => { handleDeploymentChange(obj); });
  deploymentInformer.on("delete", (obj) => { handleDeploymentDelete(obj); });
  deploymentInformer.on("error", (err) => {
    log("controller", `watch: deployment informer error: ${err}`);
  });
  deploymentInformer.on("connect", () => {
    log("controller", "watch: deployment informer connected");
  });

  // --- Service watch (all namespaces) ---

  const serviceInformer = k8s.makeInformer<k8s.V1Service>(
    kc,
    `/api/v1/services`,
    () => clients.core.listServiceForAllNamespaces({
      labelSelector: MANAGED_SELECTOR,
    }) as Promise<k8s.KubernetesListObject<k8s.V1Service>>,
    MANAGED_SELECTOR,
  );

  async function handleServiceChange(obj: k8s.V1Service): Promise<void> {
    const name = obj.metadata?.name;
    const ns = obj.metadata?.namespace;
    if (!name || !ns) return;

    const fs = getFlakeStateForNamespace(ns);
    if (!fs) return;

    const key = `service/${ns}/${name}`;
    const gen = obj.metadata?.generation;

    if (gen !== undefined && knownGeneration.get(key) === gen) return;
    if (gen !== undefined) knownGeneration.set(key, gen);

    if (fs.reconciling) return;

    if (!fs.desired) return;

    const desiredSvc = findDesiredService(fs.desired, name);
    if (!desiredSvc) return;

    try {
      await applyResource(clients.core, "Service", ns, desiredSvc);
      log("controller", `watch: corrected spec drift on service ${name}`);
    } catch (err) {
      log("controller", `watch: failed to correct service ${name}: ${err}`);
    }
  }

  async function handleServiceDelete(obj: k8s.V1Service): Promise<void> {
    const name = obj.metadata?.name;
    const ns = obj.metadata?.namespace;
    if (!name || !ns) return;

    const fs = getFlakeStateForNamespace(ns);
    if (!fs) return;

    knownGeneration.delete(`service/${ns}/${name}`);
    if (fs.reconciling) return;

    if (!fs.desired) return;

    const desiredSvc = findDesiredService(fs.desired, name);
    if (!desiredSvc) return;

    log("controller", `watch: recreating deleted service ${name}`);
    try {
      await applyResource(clients.core, "Service", ns, desiredSvc);
    } catch (err) {
      log("controller", `watch: failed to recreate service ${name}: ${err}`);
    }
  }

  serviceInformer.on("add", (obj) => {
    const name = obj.metadata?.name;
    const ns = obj.metadata?.namespace;
    const gen = obj.metadata?.generation;
    if (name && ns && gen !== undefined) knownGeneration.set(`service/${ns}/${name}`, gen);
  });
  serviceInformer.on("update", (obj) => { handleServiceChange(obj); });
  serviceInformer.on("delete", (obj) => { handleServiceDelete(obj); });
  serviceInformer.on("error", (err) => {
    log("controller", `watch: service informer error: ${err}`);
  });
  serviceInformer.on("connect", () => {
    log("controller", "watch: service informer connected");
  });

  // Start both informers
  deploymentInformer.start();
  serviceInformer.start();

  log("controller", "watch: started cluster-wide Deployment and Service informers");
}

/**
 * Find a desired Deployment by its k8s name.
 */
function findDesiredDeployment(
  desired: DesiredState,
  name: string,
): k8s.V1Deployment | null {
  for (const [, instance] of desired.instances) {
    if (instance.deployment.metadata?.name === name) {
      return instance.deployment;
    }
  }
  return null;
}

/**
 * Find a desired Service by its k8s name.
 * Checks instance services and route services (IPv4/IPv6).
 */
function findDesiredService(
  desired: DesiredState,
  name: string,
): k8s.V1Service | null {
  for (const [, instance] of desired.instances) {
    for (const svc of instance.services) {
      if (svc.metadata?.name === name) return svc;
    }
  }
  for (const svc of [...desired.routes.ipv4, ...desired.routes.ipv6]) {
    if (svc.metadata?.name === name) return svc;
  }
  return null;
}

// --- Main ---

async function main(): Promise<void> {
  const config = loadConfig();
  const kc = loadKubeConfig();
  const clients = makeClients(kc);

  log("controller", `starting (flakes=${config.flakePaths.join(", ")})`);

  // Per-flake state
  const flakeStates = new Map<string, FlakeState>();
  const namespaceToFlake = new Map<string, string>();

  for (const flakePath of config.flakePaths) {
    const namespace = deriveNamespace(flakePath);
    flakeStates.set(flakePath, {
      flakePath,
      namespace,
      desired: null,
      reconciling: false,
    });
    namespaceToFlake.set(namespace, flakePath);
    log("controller", `registered flake ${flakePath} → namespace ${namespace}`);
  }

  // Wait for k8s API (use listNamespace — we have RBAC for namespaces, not nodes)
  log("controller", "waiting for k8s API...");
  while (true) {
    try {
      await clients.core.listNamespace();
      break;
    } catch {
      await sleep(5000);
    }
  }
  log("controller", "k8s API ready");

  // Ensure namespaces with labels/annotations
  for (const [flakePath, fs] of flakeStates) {
    try {
      const existing = await clients.core.readNamespace({ name: fs.namespace });
      const labels = existing.metadata?.labels || {};
      const annotations = existing.metadata?.annotations || {};
      if (labels[LABELS.MANAGED_BY] !== MANAGED_BY_VALUE || annotations[ANNOTATIONS.FLAKE_URI] !== flakePath) {
        existing.metadata = existing.metadata || {};
        existing.metadata.labels = { ...labels, [LABELS.MANAGED_BY]: MANAGED_BY_VALUE };
        existing.metadata.annotations = { ...annotations, [ANNOTATIONS.FLAKE_URI]: flakePath };
        await clients.core.replaceNamespace({ name: fs.namespace, body: existing });
      }
    } catch {
      await clients.core.createNamespace({
        body: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: fs.namespace,
            labels: { [LABELS.MANAGED_BY]: MANAGED_BY_VALUE },
            annotations: { [ANNOTATIONS.FLAKE_URI]: flakePath },
          },
        },
      });
    }
  }

  // Configure MetalLB pools (once at startup)
  try {
    await configureMetalLB(clients, config.ipv4Address, config.ipv6Block);
  } catch (err) {
    log("controller", `MetalLB configuration failed: ${err}`);
  }

  // Webhook signaling: per-flake refresh tracking.
  const pendingRefresh = new Set<string>(); // flakePaths waiting to reconcile
  let webhookResolve: (() => void) | null = null;

  if (config.webhookSecretFile || process.env["SEED_WEBHOOK_PORT"]) {
    const port = parseInt(process.env["SEED_WEBHOOK_PORT"] || "9876", 10);
    startWebhookServer(port, config.webhookSecretFile, config.flakePaths, (flakePath: string) => {
      pendingRefresh.add(flakePath);
      if (webhookResolve) {
        webhookResolve();
        webhookResolve = null;
      }
    });
  }

  /** Wait for a webhook event. Returns immediately if one is already queued. */
  function waitForWebhook(): Promise<void> {
    if (pendingRefresh.size > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      webhookResolve = resolve;
    });
  }

  /** Run a full reconciliation cycle for a single flake. */
  async function reconcile(flakePath: string, namespace: string, useRefresh: boolean): Promise<void> {
    const fs = flakeStates.get(flakePath)!;
    fs.reconciling = true;
    log("controller", `reconciliation starting...${useRefresh ? " (--refresh)" : ""}`, flakePath);

    try {
      // List instances from flake
      const instanceNames = await listInstances(flakePath, useRefresh);

      // Build all instances
      let buildResults: Map<string, BuildResult>;

      if (config.builderImage) {
        // Use builder Jobs
        const currentGen = await deployedGeneration(clients, namespace);
        buildResults = await runBuilders(
          clients,
          flakePath,
          instanceNames,
          namespace,
          config.builderImage,
          currentGen || "initial",
          useRefresh,
        );
      } else {
        // Direct nix build (when running on host with nix access)
        buildResults = new Map();
        for (const name of instanceNames) {
          log("controller", `building image...`, name);
          const imagePath = await nixBuild(
            `${flakePath}#seeds.${name}.image`,
            useRefresh,
          );
          log("controller", `evaluating metadata...`, name);
          const meta = await nixEvalJson(
            `${flakePath}#seeds.${name}.meta`,
            useRefresh,
          ) as BuildResult["meta"];
          buildResults.set(name, { imagePath, meta });
        }
      }

      // Compute generation
      const generation = computeGeneration(
        new Map([...buildResults].map(([name, r]) => [name, r.imagePath])),
      );

      // Read route configs from flake
      let ipv4Config: IPv4Config | null = null;
      let ipv6Config: IPv6Config | null = null;
      try {
        ipv4Config = (await nixEvalJson(
          `${flakePath}#ipv4`,
          useRefresh,
        )) as IPv4Config;
      } catch { /* no ipv4 output */ }
      try {
        ipv6Config = (await nixEvalJson(
          `${flakePath}#ipv6`,
          useRefresh,
        )) as IPv6Config;
      } catch { /* no ipv6 output */ }

      // Always render + apply + reap, even if generation matches.
      // This ensures controller code changes take effect without waiting for an image change.
      const deployed = await deployedGeneration(clients, namespace);
      if (deployed === generation) {
        log("controller", `generation ${generation} unchanged, re-applying desired state`, flakePath);
      } else {
        log("controller", `deploying generation ${generation} (was: ${deployed || "none"})`, flakePath);
      }

      // Apply SeedHostTasks first and wait for readiness
      if (config.swtpmEnabled) {
        await applySeedHostTasks(clients, namespace, buildResults, generation);
        await waitForHostTasks(clients, namespace, buildResults, generation);
      }

      // Read host task statuses (now includes newly-ready tasks)
      const hostTaskStatuses = await readHostTaskStatuses(clients, namespace);

      // Render desired state
      const desired = renderDesiredState(
        namespace,
        config.swtpmEnabled,
        config.ipv4Address,
        buildResults,
        ipv4Config,
        ipv6Config,
        hostTaskStatuses,
      );

      // Apply desired state (SeedHostTasks already applied, skipped inside)
      await applyDesiredState(clients, desired);

      // Reap old resources
      await reapOldResources(clients, namespace, generation);

      fs.desired = desired;

      // Annotate namespace with commit hash for startup optimization
      const rev = await getFlakeRevision(flakePath);
      if (rev) {
        await setDeployedCommit(clients, namespace, rev);
      }

      log("controller", `reconciliation complete (generation=${generation})`, flakePath);
    } finally {
      fs.reconciling = false;
    }
  }

  // Startup: reconcile all flakes. Skip unchanged ones via commit hash.
  for (const [flakePath, fs] of flakeStates) {
    const rev = await getFlakeRevision(flakePath);
    const deployedRev = await getDeployedCommit(clients, fs.namespace);

    if (rev && deployedRev && rev === deployedRev) {
      log("controller", `flake unchanged (rev=${rev}), loading existing state`, flakePath);
      fs.desired = await loadExistingDesired(clients, fs.namespace);
    } else {
      log("controller", `flake changed or first deploy (rev=${rev || "unknown"}, deployed=${deployedRev || "none"})`, flakePath);
      await reconcile(flakePath, fs.namespace, false);
    }
  }

  // Start k8s API watches for drift correction (cluster-wide).
  startWatches(kc, clients, flakeStates, namespaceToFlake);

  // Event-driven loop: wait for webhook, then reconcile only affected flakes.
  // Crashes on failure — k8s restart gives free backoff and retry.
  while (true) {
    await waitForWebhook();
    // Drain all pending flakes
    const toReconcile = [...pendingRefresh];
    pendingRefresh.clear();

    for (const flakePath of toReconcile) {
      const fs = flakeStates.get(flakePath);
      if (!fs) {
        log("controller", `webhook for unknown flake ${flakePath}, skipping`);
        continue;
      }
      log("controller", `webhook triggered reconciliation`, flakePath);
      await reconcile(flakePath, fs.namespace, true);
    }
    // Clear any webhooks that arrived during the run — we already used --refresh,
    // so the latest commit was captured. Don't clear ALL — only the ones we just processed.
    // New webhooks for different flakes should be preserved.
  }
}

// Only run main() when this file is the entry point, not when imported for testing.
const isEntryPoint = process.argv[1]?.endsWith("controller.mjs") ||
  import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
