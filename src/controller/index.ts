// Seed controller — main reconciliation engine.
//
// Two-level reconciliation:
// 1. Generation: on flake change, build instances, compute generation hash, render desired state
// 2. Continuous: watch for drift and self-heal (missing/extra/drifted resources)

import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig, makeClients, deriveNamespace, computeGeneration, log, sleep, applyResource } from "../shared/kube.js";
import { LABELS, MANAGED_BY_VALUE, MANAGED_SELECTOR, ANNOTATIONS, seedLabels } from "../shared/labels.js";
import type { ControllerConfig, DesiredState, InstanceState, IPv4Config, IPv6Config, SeedHostTask, BuildResult } from "../shared/types.js";
import { generatePod, generatePVC, generateService, generateHostTask } from "./manifests.js";
import { generateIPv4Services, generateIPv6Services } from "./routes.js";
import { configureMetalLB } from "./metallb.js";
import { runBuilders } from "./builder.js";
import { startWebhookServer } from "./webhook.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- Configuration ---

function loadConfig(): ControllerConfig {
  const flakePath = process.env["SEED_FLAKE_PATH"];
  if (!flakePath) throw new Error("SEED_FLAKE_PATH must be set");

  const namespace =
    process.env["SEED_NAMESPACE"] || deriveNamespace(flakePath);

  return {
    flakePath,
    namespace,
    interval: parseInt(process.env["SEED_INTERVAL"] || "30", 10),
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

// --- Reconciliation ---

/**
 * Build desired state from build results and route configs.
 */
export function renderDesiredState(
  config: ControllerConfig,
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
    if (config.swtpmEnabled) {
      const status = hostTaskStatuses.get(name);
      if (status?.ready) {
        tpmSocketPath = status.socketPath;
      }
    }

    const pod = generatePod(
      name,
      imageRef,
      generation,
      config.namespace,
      meta,
      tpmSocketPath,
    );

    const services: k8s.V1Service[] = [];
    const svc = generateService(name, generation, config.namespace, meta);
    if (svc) services.push(svc);

    const pvcs: k8s.V1PersistentVolumeClaim[] = [];
    for (const [key, entry] of Object.entries(meta.storage)) {
      pvcs.push(generatePVC(name, key, entry.size, generation, config.namespace));
    }

    // TPM identity PVC
    if (config.swtpmEnabled) {
      pvcs.push(generatePVC(name, "tpm-identity", "10Mi", generation, config.namespace));
    }

    const hostTask = config.swtpmEnabled
      ? generateHostTask(name, config.namespace, generation)
      : null;

    instances.set(name, { imagePath: result.imagePath, meta, pod, services, pvcs, hostTask });
  }

  // Route services
  const ipv4Services = ipv4Config
    ? generateIPv4Services(ipv4Config, config.ipv4Address, generation, config.namespace)
    : [];
  const ipv6Services = ipv6Config
    ? generateIPv6Services(ipv6Config, generation, config.namespace)
    : [];

  return {
    generation,
    namespace: config.namespace,
    instances,
    routes: { ipv4: ipv4Services, ipv6: ipv6Services },
  };
}

/**
 * Apply the desired state to the cluster.
 * Creates missing resources, skips existing ones (pods are immutable).
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

  // Apply PVCs (before pods, so volumes are available)
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

  // Apply pods
  for (const [name, instance] of desired.instances) {
    try {
      // Check if existing pod has different image → delete first
      try {
        const existing = await clients.core.readNamespacedPod({
          name: instance.pod.metadata!.name!,
          namespace,
        });
        const currentImage = existing.spec?.containers?.[0]?.image;
        const desiredImage = instance.pod.spec!.containers[0].image;
        if (currentImage !== desiredImage) {
          log("controller", `image changed, replacing pod...`, name);
          await clients.core.deleteNamespacedPod({
            name: instance.pod.metadata!.name!,
            namespace,
            gracePeriodSeconds: 10,
          });
          // Wait for pod to actually be gone
          for (let i = 0; i < 30; i++) {
            await sleep(1000);
            try {
              await clients.core.readNamespacedPod({
                name: instance.pod.metadata!.name!,
                namespace,
              });
            } catch {
              break; // Pod is gone
            }
          }
          await clients.core.createNamespacedPod({
            namespace,
            body: instance.pod,
          });
          log("controller", `pod replaced`, name);
        } else {
          // Pod image unchanged — update generation label
          const existingGen = existing.metadata?.labels?.[LABELS.GENERATION];
          if (existingGen !== desired.generation) {
            existing.metadata = existing.metadata || {};
            existing.metadata.labels = {
              ...existing.metadata.labels,
              [LABELS.GENERATION]: desired.generation,
            };
            // Can't replace pod spec, but we can replace metadata
            // Use a targeted label replace via read-modify-replace on the pod
            await clients.core.replaceNamespacedPod({
              name: instance.pod.metadata!.name!,
              namespace,
              body: existing,
            });
            log("controller", `pod generation label updated`, name);
          } else {
            log("controller", `pod unchanged`, name);
          }
        }
      } catch {
        // Pod doesn't exist — create it
        await clients.core.createNamespacedPod({
          namespace,
          body: instance.pod,
        });
        log("controller", `pod created`, name);
      }
    } catch (err) {
      log("controller", `pod error: ${err}`, name);
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
  // Reap old pods
  try {
    const pods = await clients.core.listNamespacedPod({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const pod of pods.items) {
      const podGen = pod.metadata?.labels?.[LABELS.GENERATION];
      // Skip builder pods
      if (pod.metadata?.labels?.["seed.loom.farm/builder"] === "true") continue;
      if (podGen && podGen !== generation) {
        log("controller", `reaping pod: ${pod.metadata!.name}`);
        await clients.core.deleteNamespacedPod({
          name: pod.metadata!.name!,
          namespace,
          gracePeriodSeconds: 10,
        });
      }
    }
  } catch (err) {
    log("controller", `error reaping pods: ${err}`);
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
 * Get the generation currently deployed (from any seed-managed pod).
 */
async function deployedGeneration(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
): Promise<string> {
  try {
    const pods = await clients.core.listNamespacedPod({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    // Find first non-builder pod that is actually running (not Unknown/Failed)
    for (const pod of pods.items) {
      if (pod.metadata?.labels?.["seed.loom.farm/builder"] === "true") continue;
      const phase = pod.status?.phase;
      if (phase !== "Running" && phase !== "Pending") continue;
      const gen = pod.metadata?.labels?.[LABELS.GENERATION];
      if (gen) return gen;
    }
  } catch {
    // Namespace or pods might not exist yet
  }
  return "";
}

// --- Self-healing reconciliation (Level 2) ---

/**
 * Check for and fix drift between desired and actual state.
 * Runs on a timer and recreates missing resources.
 */
async function selfHeal(
  clients: ReturnType<typeof makeClients>,
  desired: DesiredState | null,
): Promise<void> {
  if (!desired) return;

  const { namespace } = desired;

  for (const [name, instance] of desired.instances) {
    // Check pod exists and is healthy
    try {
      const existing = await clients.core.readNamespacedPod({
        name: instance.pod.metadata!.name!,
        namespace,
      });
      // Delete unhealthy pods (Unknown/Failed) so they get recreated
      const phase = existing.status?.phase;
      if (phase === "Unknown" || phase === "Failed") {
        log("controller", `self-heal: deleting unhealthy pod (phase=${phase})`, name);
        await clients.core.deleteNamespacedPod({
          name: instance.pod.metadata!.name!,
          namespace,
          gracePeriodSeconds: 0,
        });
        await sleep(2000);
        await clients.core.createNamespacedPod({
          namespace,
          body: instance.pod,
        });
        log("controller", `self-heal: recreated pod`, name);
      }
    } catch {
      // Pod missing — recreate
      log("controller", `self-heal: recreating missing pod`, name);
      try {
        await clients.core.createNamespacedPod({
          namespace,
          body: instance.pod,
        });
      } catch (err) {
        log("controller", `self-heal: failed to recreate pod: ${err}`, name);
      }
    }

    // Check services exist
    for (const svc of instance.services) {
      try {
        await clients.core.readNamespacedService({
          name: svc.metadata!.name!,
          namespace,
        });
      } catch {
        log("controller", `self-heal: recreating missing service ${svc.metadata!.name}`, name);
        try {
          await clients.core.createNamespacedService({ namespace, body: svc });
        } catch (err) {
          log("controller", `self-heal: failed to recreate service: ${err}`, name);
        }
      }
    }
  }

  // Check route services
  for (const svc of [...desired.routes.ipv4, ...desired.routes.ipv6]) {
    try {
      await clients.core.readNamespacedService({
        name: svc.metadata!.name!,
        namespace,
      });
    } catch {
      log("controller", `self-heal: recreating missing route service ${svc.metadata!.name}`);
      try {
        await clients.core.createNamespacedService({ namespace, body: svc });
      } catch (err) {
        log("controller", `self-heal: failed to recreate route service: ${err}`);
      }
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  const config = loadConfig();
  const kc = loadKubeConfig();
  const clients = makeClients(kc);

  log("controller", `starting (flake=${config.flakePath} namespace=${config.namespace})`);

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

  // Ensure namespace with labels/annotations
  try {
    const existing = await clients.core.readNamespace({ name: config.namespace });
    // Update labels/annotations if missing
    const labels = existing.metadata?.labels || {};
    const annotations = existing.metadata?.annotations || {};
    if (labels[LABELS.MANAGED_BY] !== MANAGED_BY_VALUE || annotations[ANNOTATIONS.FLAKE_URI] !== config.flakePath) {
      existing.metadata = existing.metadata || {};
      existing.metadata.labels = { ...labels, [LABELS.MANAGED_BY]: MANAGED_BY_VALUE };
      existing.metadata.annotations = { ...annotations, [ANNOTATIONS.FLAKE_URI]: config.flakePath };
      await clients.core.replaceNamespace({ name: config.namespace, body: existing });
    }
  } catch {
    await clients.core.createNamespace({
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: config.namespace,
          labels: { [LABELS.MANAGED_BY]: MANAGED_BY_VALUE },
          annotations: { [ANNOTATIONS.FLAKE_URI]: config.flakePath },
        },
      },
    });
  }

  // Configure MetalLB pools (once at startup)
  try {
    await configureMetalLB(clients, config.ipv4Address, config.ipv6Block);
  } catch (err) {
    log("controller", `MetalLB configuration failed: ${err}`);
  }

  // Webhook: trigger refresh flag
  let refreshRequested = false;
  if (config.webhookSecretFile || process.env["SEED_WEBHOOK_PORT"]) {
    const port = parseInt(process.env["SEED_WEBHOOK_PORT"] || "9876", 10);
    startWebhookServer(port, config.webhookSecretFile, () => {
      refreshRequested = true;
    });
  }

  // State
  let currentDesired: DesiredState | null = null;
  let selfHealCounter = 0;

  // Main reconciliation loop
  while (true) {
    try {
      const useRefresh = refreshRequested;
      if (refreshRequested) {
        log("controller", "refresh trigger detected, bypassing nix cache");
        refreshRequested = false;
      }

      log("controller", "reconciliation starting...");

      // List instances from flake
      let instanceNames: string[];
      try {
        instanceNames = await listInstances(config.flakePath, useRefresh);
      } catch (err) {
        log("controller", `failed to list instances: ${err}`);
        await sleep(config.interval * 1000);
        continue;
      }

      // Build all instances
      let buildResults: Map<string, BuildResult>;

      if (config.builderImage) {
        // Use builder Jobs
        const currentGen = await deployedGeneration(clients, config.namespace);
        try {
          buildResults = await runBuilders(
            clients,
            config.flakePath,
            instanceNames,
            config.namespace,
            config.builderImage,
            currentGen || "initial",
            useRefresh,
          );
        } catch (err) {
          log("controller", `builder failed: ${err}`);
          await sleep(config.interval * 1000);
          continue;
        }
      } else {
        // Direct nix build (when running on host with nix access)
        buildResults = new Map();
        let buildFailed = false;
        for (const name of instanceNames) {
          try {
            log("controller", `building image...`, name);
            const imagePath = await nixBuild(
              `${config.flakePath}#seeds.${name}.image`,
              useRefresh,
            );
            log("controller", `evaluating metadata...`, name);
            const meta = await nixEvalJson(
              `${config.flakePath}#seeds.${name}.meta`,
              useRefresh,
            ) as BuildResult["meta"];
            buildResults.set(name, { imagePath, meta });
          } catch (err) {
            log("controller", `build failed: ${err}`, name);
            buildFailed = true;
          }
        }
        if (buildFailed) {
          log("controller", "some builds failed, skipping reconciliation");
          await sleep(config.interval * 1000);
          continue;
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
          `${config.flakePath}#ipv4`,
          useRefresh,
        )) as IPv4Config;
      } catch { /* no ipv4 output */ }
      try {
        ipv6Config = (await nixEvalJson(
          `${config.flakePath}#ipv6`,
          useRefresh,
        )) as IPv6Config;
      } catch { /* no ipv6 output */ }

      // Check if generation already deployed
      const deployed = await deployedGeneration(clients, config.namespace);
      if (deployed === generation) {
        log("controller", `generation ${generation} already deployed, nothing to do`);
        // Still run self-heal check
        await selfHeal(clients, currentDesired);
        await sleep(config.interval * 1000);
        continue;
      }

      log("controller", `deploying generation ${generation} (was: ${deployed || "none"})`);

      // Read host task statuses
      const hostTaskStatuses = await readHostTaskStatuses(clients, config.namespace);

      // Render desired state
      const desired = renderDesiredState(
        config,
        buildResults,
        ipv4Config,
        ipv6Config,
        hostTaskStatuses,
      );

      // Apply desired state
      await applyDesiredState(clients, desired);

      // Reap old resources
      await reapOldResources(clients, config.namespace, generation);

      currentDesired = desired;

      log("controller", `reconciliation complete (generation=${generation})`);
    } catch (err) {
      log("controller", `reconciliation error: ${err}`);
    }

    // Self-heal every 3rd interval
    selfHealCounter++;
    if (selfHealCounter >= 3) {
      selfHealCounter = 0;
      try {
        await selfHeal(clients, currentDesired);
      } catch (err) {
        log("controller", `self-heal error: ${err}`);
      }
    }

    await sleep(config.interval * 1000);
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
