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
import { loadKubeConfig, makeClients, deriveNamespace, deriveNamespaceFromIdentity, computeGeneration, log, sleep, applyResource, applyDeployment } from "../shared/kube.js";
import { LABELS, MANAGED_BY_VALUE, MANAGED_SELECTOR, ANNOTATIONS, seedLabels } from "../shared/labels.js";
import type { ControllerConfig, DesiredState, InstanceState, IPv4Config, IPv6Config, SeedHostTask, SeedFlake, BuildResult, SeedDNSRecord, SeedDomain, CombineConfig, CombineDomainConfig } from "../shared/types.js";
import { generateDeployment, generatePVC, generateService, generateIngressService, generateHostTask, generateInstanceDNSRecords, generateDomainCRD } from "./manifests.js";
import { generateIPv4Services, generateIPv6Services } from "./routes.js";
import { configureMetalLB, readBGPConfig } from "./metallb.js";
import { runBuilders } from "./builder.js";
import { runViaPoolManager } from "./pool-client.js";
import { startWebhookServer } from "./webhook.js";
import { initApi, updateKeyIndex, updateValidNamespaces, setPlantHandler, setReplantHandler, getReconcileStatus, updateReconcileStatus, type KeyIndex, type NamespaceEntry, type ReconcileStatus } from "./api.js";
import { readSeedIdentity, isValidIpnsCid, verifyPlantSignature } from "../shared/identity.js";
import { loadPdnsApiKey, startDNSReconciler } from "./dns.js";
import { startDomainController } from "./domains.js";
import { initAcme, updateAcmeNamespaces, updateAcmeValidZones } from "./acme.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

// --- Per-flake state ---

interface FlakeState {
  flakePath: string;
  namespace: string;
  identity: string; // IPNS CID from .seed-identity (empty for legacy URI-derived namespaces)
  desired: DesiredState | null;
  reconciling: boolean;
}

// --- Configuration ---

function loadConfig(): ControllerConfig {
  const flakePathsRaw = process.env["SEED_FLAKE_PATHS"] || "";
  const flakePaths = flakePathsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    flakePaths,
    ipv4Address: process.env["SEED_IPV4_ADDRESS"] || "",
    ipv6Block: process.env["SEED_IPV6_BLOCK"] || "",
    webhookSecretFile: process.env["SEED_WEBHOOK_SECRET_FILE"] || "",
    builderImage: process.env["SEED_BUILDER_IMAGE"] || "",
    poolManagerUrl: process.env["SEED_POOL_MANAGER_URL"] || "",
    swtpmEnabled: !!process.env["SEED_SWTPM_ENABLED"],
    pdnsApiUrl: process.env["SEED_PDNS_API_URL"] || "",
    pdnsApiKeyFile: process.env["SEED_PDNS_API_KEY_FILE"] || "",
    pdnsZone: process.env["SEED_PDNS_ZONE"] || "loom.farm.",
    instanceDomain: process.env["SEED_INSTANCE_DOMAIN"] || "seed.loom.farm",
    acmeEnabled: !!process.env["SEED_ACME_ENABLED"],
    acmeAccountKeyFile: process.env["SEED_ACME_ACCOUNT_KEY_FILE"] || "",
    siloHost: process.env["SEED_SILO_HOST"] || "silo.loom.farm",
    namesiloApiKeyFile: process.env["SEED_NAMESILO_API_KEY_FILE"] || "",
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

/** Send an HTTP(S) HEAD request and return response headers. */
async function httpHead(url: string): Promise<Record<string, string | string[] | undefined>> {
  const mod = url.startsWith("https") ? await import("node:https") : await import("node:http");
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: "HEAD", timeout: 10_000 }, (res) => {
      res.resume(); // drain
      resolve(res.headers);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

/** Get the git revision of a flake (fast, no build).
 *  For tarball flakes (silo), sends a HEAD request — silo returns a Link header
 *  with the commit SHA in the immutable archive URL. For git flakes, uses nix
 *  flake metadata. */
async function getFlakeRevision(flakePath: string): Promise<string | null> {
  // Tarball flakes: tarball+https://host/repo/archive/branch.tar.gz
  // Silo returns: Link: <https://host/repo/archive/SHA.tar.gz?...>; rel="immutable"
  const tarballMatch = flakePath.match(/^tarball\+(https?:\/\/.+)$/);
  if (tarballMatch) {
    try {
      const headers = await httpHead(tarballMatch[1]);
      const link = typeof headers.link === "string" ? headers.link : headers.link?.[0] || "";
      const linkMatch = link.match(/\/archive\/([0-9a-f]{7,40})\.tar\.gz/);
      if (linkMatch) return linkMatch[1];
    } catch { /* fall through to nix metadata */ }
  }

  try {
    const args = ["flake", "metadata", flakePath, "--json"];
    if (flakePath.startsWith("tarball+")) args.push("--refresh");
    const { stdout } = await execFileAsync("nix", args, { timeout: 60_000 });
    const meta = JSON.parse(stdout);
    return meta.revision || meta.locked?.narHash || null;
  } catch {
    return null;
  }
}

// --- Authorized keys extraction ---

/**
 * Extract .authorized_keys from a flake's root directory.
 * The controller evaluates the flake's self attribute to find the source tree,
 * then reads .authorized_keys from it. Returns an array of SSH public key lines.
 */
async function extractAuthorizedKeys(
  flakePath: string,
  refresh: boolean,
): Promise<string[]> {
  try {
    // Get the flake's source tree path via `nix flake metadata`
    const args = ["flake", "metadata", flakePath, "--json"];
    if (refresh) args.push("--refresh");
    const { stdout } = await execFileAsync("nix", args, { timeout: 60_000 });
    const meta = JSON.parse(stdout);
    const storePath = meta.path;
    if (!storePath) return [];

    // Read .authorized_keys from the flake root
    const keysPath = `${storePath}/.authorized_keys`;
    const content = await readFile(keysPath, "utf-8").catch(() => "");
    if (!content.trim()) return [];

    // Parse: skip empty lines and comments
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Extract a short repo name from a flake path.
 * github:loomtex/seed → "seed"
 * tarball+https://silo.loom.farm/shoot-demo/archive/master.tar.gz → "shoot-demo"
 */
function repoName(flakePath: string): string {
  // github:owner/repo or github:owner/repo#...
  const ghMatch = flakePath.match(/^github:[^/]+\/([^#?]+)/);
  if (ghMatch) return ghMatch[1];
  // tarball+https://host/repo/archive/...
  const tbMatch = flakePath.match(/^tarball\+https?:\/\/[^/]+\/([^/]+)\//);
  if (tbMatch) return tbMatch[1];
  // git+https://host/repo.git or git+ssh://...
  const gitMatch = flakePath.match(/\/([^/]+?)(?:\.git)?(?:#.*)?$/);
  if (gitMatch) return gitMatch[1];
  // Fallback: use the whole thing
  return flakePath;
}

/**
 * Build a key→namespace index from all flake states.
 * Called after reconciliation to update the API's key index.
 */
async function buildKeyIndex(
  flakeStates: Map<string, FlakeState>,
  refresh: boolean,
): Promise<KeyIndex> {
  const keys: Record<string, NamespaceEntry[]> = {};

  for (const [flakePath, fs] of flakeStates) {
    const authorizedKeys = await extractAuthorizedKeys(flakePath, refresh);
    const entry: NamespaceEntry = { name: repoName(flakePath), namespace: fs.namespace, identity: fs.identity };
    for (const key of authorizedKeys) {
      if (!keys[key]) keys[key] = [];
      if (!keys[key].some((e) => e.namespace === fs.namespace)) {
        keys[key].push(entry);
      }
    }
  }

  return { keys };
}

// --- Reconciliation ---

/**
 * Build desired state from build results and route configs.
 */
export function renderDesiredState(
  namespace: string,
  swtpmEnabled: boolean,
  ipv4Address: string,
  poolManagerUrl: string,
  buildResults: Map<string, BuildResult>,
  ipv4Config: IPv4Config | null,
  ipv6Config: IPv6Config | null,
  hostTaskStatuses: Map<string, { ready: boolean; socketPath: string }>,
  acmeUrl?: string,
  instanceDomain?: string,
  domains?: Record<string, CombineDomainConfig>,
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
      poolManagerUrl || undefined,
      acmeUrl,
      instanceDomain,
    );

    const services: k8s.V1Service[] = [];
    const svc = generateService(name, generation, namespace, meta);
    if (svc) services.push(svc);

    const pvcs: k8s.V1PersistentVolumeClaim[] = [];
    for (const [key, entry] of Object.entries(meta.storage)) {
      pvcs.push(generatePVC(name, key, entry.size, generation, namespace));
    }

    const ingressService = generateIngressService(name, generation, namespace, meta);

    const hostTask = swtpmEnabled
      ? generateHostTask(name, namespace, generation)
      : null;

    const dnsRecords = generateInstanceDNSRecords(
      name,
      generation,
      namespace,
      meta,
      instanceDomain || "seed.loom.farm",
      domains,
    );

    instances.set(name, { imagePath: result.imagePath, meta, deployment, services, ingressService, pvcs, hostTask, dnsRecords });
  }

  // Route services
  const ipv4Services = ipv4Config
    ? generateIPv4Services(ipv4Config, ipv4Address, generation, namespace)
    : [];
  const ipv6Services = ipv6Config
    ? generateIPv6Services(ipv6Config, generation, namespace)
    : [];

  // Generate SeedDomain CRDs from combine.domains
  const domainCRDs: SeedDomain[] = [];
  if (domains) {
    for (const [domainName, domainConfig] of Object.entries(domains)) {
      domainCRDs.push(generateDomainCRD(domainName, domainConfig, generation, namespace));
    }
  }

  return {
    generation,
    namespace,
    instances,
    routes: { ipv4: ipv4Services, ipv6: ipv6Services },
    domains: domainCRDs,
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
 * Ensure the seed-ca ConfigMap exists in a namespace with the platform CA cert.
 * Creates or updates the ConfigMap so instances can trust the platform CA.
 */
async function ensureSeedCAConfigMap(
  core: k8s.CoreV1Api,
  namespace: string,
  caCert: string,
): Promise<void> {
  const configMap: k8s.V1ConfigMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "seed-ca",
      namespace,
      labels: { [LABELS.MANAGED_BY]: MANAGED_BY_VALUE },
    },
    data: { "ca.crt": caCert },
  };

  try {
    const existing = await core.readNamespacedConfigMap({ name: "seed-ca", namespace });
    if (existing.data?.["ca.crt"] !== caCert) {
      configMap.metadata!.resourceVersion = existing.metadata?.resourceVersion;
      await core.replaceNamespacedConfigMap({ name: "seed-ca", namespace, body: configMap });
      log("controller", `updated seed-ca ConfigMap`, namespace);
    }
  } catch {
    await core.createNamespacedConfigMap({ namespace, body: configMap });
    log("controller", `created seed-ca ConfigMap`, namespace);
  }
}

/**
 * Apply the desired state to the cluster.
 * Creates missing resources, updates existing ones.
 */
async function applyDesiredState(
  clients: ReturnType<typeof makeClients>,
  desired: DesiredState,
  platformCACert?: string,
): Promise<void> {
  const { namespace } = desired;

  // Replicate platform CA certificate as ConfigMap in instance namespace
  if (platformCACert) {
    try {
      await ensureSeedCAConfigMap(clients.core, namespace, platformCACert);
    } catch (err) {
      log("controller", `seed-ca ConfigMap error: ${err}`, namespace);
    }
  }

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
      log("controller", `applied deployment ${name}`, name);
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

  // Apply ingress services (per-instance IPv6 LoadBalancer)
  for (const [name, instance] of desired.instances) {
    if (instance.ingressService) {
      try {
        await applyResource(clients.core, "Service", namespace, instance.ingressService);
        log("controller", `applied ingress service ${instance.ingressService.metadata!.name}`, name);
      } catch (err) {
        log("controller", `ingress service error: ${err}`, name);
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

  // Apply SeedDomain CRDs
  for (const domain of desired.domains) {
    try {
      const existing = await clients.custom.getNamespacedCustomObject({
        group: "seed.loom.farm",
        version: "v1alpha1",
        namespace,
        plural: "seeddomains",
        name: domain.metadata!.name!,
      }) as SeedDomain;
      // Update generation label if changed, preserve status
      const existingGen = existing.metadata?.labels?.[LABELS.GENERATION];
      if (existingGen !== desired.generation) {
        existing.metadata = existing.metadata || {};
        existing.metadata.labels = {
          ...existing.metadata.labels,
          ...domain.metadata!.labels,
        };
        existing.spec = domain.spec;
        await clients.custom.replaceNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seeddomains",
          name: domain.metadata!.name!,
          body: existing,
        });
        log("controller", `updated SeedDomain ${domain.spec.name}`);
      }
    } catch {
      await clients.custom.createNamespacedCustomObject({
        group: "seed.loom.farm",
        version: "v1alpha1",
        namespace,
        plural: "seeddomains",
        body: domain,
      });
      log("controller", `created SeedDomain ${domain.spec.name}`);
    }
  }

  // Apply SeedDNSRecords
  for (const [name, instance] of desired.instances) {
    for (const dnsRecord of instance.dnsRecords) {
      try {
        const existing = await clients.custom.getNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seeddnsrecords",
          name: dnsRecord.metadata!.name!,
        }) as SeedDNSRecord;
        // Update generation label if changed
        const existingGen = existing.metadata?.labels?.[LABELS.GENERATION];
        if (existingGen !== desired.generation) {
          existing.metadata = existing.metadata || {};
          existing.metadata.labels = {
            ...existing.metadata.labels,
            ...dnsRecord.metadata!.labels,
          };
          existing.spec = dnsRecord.spec;
          await clients.custom.replaceNamespacedCustomObject({
            group: "seed.loom.farm",
            version: "v1alpha1",
            namespace,
            plural: "seeddnsrecords",
            name: dnsRecord.metadata!.name!,
            body: existing,
          });
          log("controller", `updated SeedDNSRecord ${dnsRecord.metadata!.name}`, name);
        }
      } catch {
        await clients.custom.createNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seeddnsrecords",
          body: dnsRecord,
        });
        log("controller", `created SeedDNSRecord ${dnsRecord.metadata!.name}`, name);
      }
    }
  }
}

/**
 * Reap managed resources that are NOT in the desired state.
 * Uses desired resource names (not generation labels) to avoid reaping
 * resources we just applied — k8s list cache can lag behind writes.
 * PVCs are never reaped — delete manually if needed.
 */
async function reapOldResources(
  clients: ReturnType<typeof makeClients>,
  namespace: string,
  desired: DesiredState,
): Promise<void> {
  // Build sets of desired resource names
  const desiredDeployments = new Set<string>();
  const desiredServices = new Set<string>();
  const desiredHostTasks = new Set<string>();
  const desiredDNSRecords = new Set<string>();
  const desiredDomains = new Set<string>();

  for (const domain of desired.domains) {
    const name = domain.metadata?.name;
    if (name) desiredDomains.add(name);
  }

  for (const [, instance] of desired.instances) {
    const depName = instance.deployment.metadata?.name;
    if (depName) desiredDeployments.add(depName);
    for (const svc of instance.services) {
      const name = svc.metadata?.name;
      if (name) desiredServices.add(name);
    }
    if (instance.ingressService) {
      const name = instance.ingressService.metadata?.name;
      if (name) desiredServices.add(name);
    }
    if (instance.hostTask) {
      const name = instance.hostTask.metadata?.name;
      if (name) desiredHostTasks.add(name);
    }
    for (const dnsRecord of instance.dnsRecords) {
      const name = dnsRecord.metadata?.name;
      if (name) desiredDNSRecords.add(name);
    }
  }
  for (const svc of [...desired.routes.ipv4, ...desired.routes.ipv6]) {
    const name = svc.metadata?.name;
    if (name) desiredServices.add(name);
  }

  // Reap Deployments not in desired state
  try {
    const deployments = await clients.apps.listNamespacedDeployment({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const dep of deployments.items) {
      const name = dep.metadata?.name;
      if (name && !desiredDeployments.has(name)) {
        log("controller", `reaping deployment: ${name}`);
        await clients.apps.deleteNamespacedDeployment({ name, namespace });
      }
    }
  } catch (err) {
    log("controller", `error reaping deployments: ${err}`);
  }

  // Reap Services not in desired state
  try {
    const svcs = await clients.core.listNamespacedService({
      namespace,
      labelSelector: MANAGED_SELECTOR,
    });
    for (const svc of svcs.items) {
      const name = svc.metadata?.name;
      if (name && !desiredServices.has(name)) {
        log("controller", `reaping service: ${name}`);
        await clients.core.deleteNamespacedService({ name, namespace });
      }
    }
  } catch (err) {
    log("controller", `error reaping services: ${err}`);
  }

  // Reap SeedHostTasks not in desired state
  try {
    const tasks = await clients.custom.listNamespacedCustomObject({
      group: "seed.loom.farm",
      version: "v1alpha1",
      namespace,
      plural: "seedhosttasks",
    }) as { items: SeedHostTask[] };
    for (const task of tasks.items) {
      const name = task.metadata?.name;
      if (name && !desiredHostTasks.has(name)) {
        log("controller", `reaping SeedHostTask: ${name}`);
        await clients.custom.deleteNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seedhosttasks",
          name,
        });
      }
    }
  } catch (err) {
    log("controller", `error reaping SeedHostTasks: ${err}`);
  }

  // Reap SeedDNSRecords not in desired state
  try {
    const dnsRecords = await clients.custom.listNamespacedCustomObject({
      group: "seed.loom.farm",
      version: "v1alpha1",
      namespace,
      plural: "seeddnsrecords",
    }) as { items: SeedDNSRecord[] };
    for (const record of dnsRecords.items) {
      const name = record.metadata?.name;
      if (name && !desiredDNSRecords.has(name)) {
        log("controller", `reaping SeedDNSRecord: ${name}`);
        await clients.custom.deleteNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seeddnsrecords",
          name,
        });
      }
    }
  } catch (err) {
    log("controller", `error reaping SeedDNSRecords: ${err}`);
  }

  // Reap SeedDomains not in desired state
  try {
    const domains = await clients.custom.listNamespacedCustomObject({
      group: "seed.loom.farm",
      version: "v1alpha1",
      namespace,
      plural: "seeddomains",
    }) as { items: SeedDomain[] };
    for (const domain of domains.items) {
      const name = domain.metadata?.name;
      if (name && !desiredDomains.has(name)) {
        log("controller", `reaping SeedDomain: ${name}`);
        await clients.custom.deleteNamespacedCustomObject({
          group: "seed.loom.farm",
          version: "v1alpha1",
          namespace,
          plural: "seeddomains",
          name,
        });
      }
    }
  } catch (err) {
    log("controller", `error reaping SeedDomains: ${err}`);
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
 * Load existing desired state from cluster resources.
 * Used by drift-correction watches to rebuild state after reconnection.
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
        ingressService: null,
        pvcs: [],
        hostTask: null,
        dnsRecords: [],
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
      if (serviceType === "ipv4" || serviceType === "ipv6") continue; // Route services handled below
      if (serviceType === "ingress" && instanceName && instances.has(instanceName)) {
        instances.get(instanceName)!.ingressService = svc;
        continue;
      }
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
    domains: [],
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
    if (instance.ingressService?.metadata?.name === name) return instance.ingressService;
  }
  for (const svc of [...desired.routes.ipv4, ...desired.routes.ipv6]) {
    if (svc.metadata?.name === name) return svc;
  }
  return null;
}

// --- SeedFlake CRD helpers ---

/** List all SeedFlake CRDs from the cluster. */
async function listSeedFlakes(
  clients: ReturnType<typeof makeClients>,
): Promise<SeedFlake[]> {
  try {
    const result = await clients.custom.listClusterCustomObject({
      group: "seed.loom.farm",
      version: "v1alpha1",
      plural: "seedflakes",
    }) as { items: SeedFlake[] };
    return result.items;
  } catch {
    return [];
  }
}

/** Update SeedFlake status subresource (read-then-replace pattern). */
async function updateSeedFlakeStatus(
  clients: ReturnType<typeof makeClients>,
  name: string,
  status: SeedFlake["status"],
): Promise<void> {
  const existing = await clients.custom.getClusterCustomObject({
    group: "seed.loom.farm",
    version: "v1alpha1",
    plural: "seedflakes",
    name,
  }) as SeedFlake;
  existing.status = status;
  await clients.custom.replaceClusterCustomObjectStatus({
    group: "seed.loom.farm",
    version: "v1alpha1",
    plural: "seedflakes",
    name,
    body: existing,
  });
}

/**
 * Register active SeedFlake CRDs into the flake state maps.
 * Returns new flake paths added (for initial reconciliation).
 */
async function loadSeedFlakes(
  clients: ReturnType<typeof makeClients>,
  flakeStates: Map<string, FlakeState>,
  namespaceToFlake: Map<string, string>,
): Promise<string[]> {
  const seedFlakes = await listSeedFlakes(clients);
  const newPaths: string[] = [];

  for (const sf of seedFlakes) {
    const uri = sf.spec?.flakeUri;
    if (!uri) continue; // Unclaimed invite

    if (flakeStates.has(uri)) continue; // Already registered (bootstrap or prior load)

    // Use status.namespace as canonical (preserves namespace across URI changes).
    // Fall back to identity-derived or URI-derived for CRDs without status set.
    const identity = sf.spec?.identity || "";
    let namespace = sf.status?.namespace || "";
    if (!namespace) {
      namespace = identity ? deriveNamespaceFromIdentity(identity) : deriveNamespace(uri);
    }

    flakeStates.set(uri, {
      flakePath: uri,
      namespace,
      identity,
      desired: null,
      reconciling: false,
    });
    namespaceToFlake.set(namespace, uri);
    newPaths.push(uri);
    log("controller", `registered SeedFlake ${sf.metadata?.name}: ${uri} → ${namespace}${identity ? ` (identity: ${identity.slice(0, 16)}...)` : ""}`);
  }

  return newPaths;
}

/**
 * Expand silo: shorthand to full tarball URI.
 * silo:my-app → tarball+https://<siloHost>/my-app/archive/master.tar.gz
 */
function expandFlakeUri(uri: string, siloHost: string): string {
  if (uri.startsWith("silo:")) {
    const repoName = uri.slice(5);
    return `tarball+https://${siloHost}/${repoName}/archive/master.tar.gz`;
  }
  return uri;
}

/**
 * Validate a flake URI format.
 * Must match known schemes: github:, tarball+, git+, path:, or silo: (pre-expanded).
 */
function isValidFlakeUri(uri: string): boolean {
  return /^(github:|tarball\+https?:|git\+(https?|ssh):|path:)/.test(uri);
}

/**
 * Handle a plant request: claim an invite, register the flake, trigger reconciliation.
 */
async function handlePlant(
  clients: ReturnType<typeof makeClients>,
  config: ControllerConfig,
  flakeStates: Map<string, FlakeState>,
  namespaceToFlake: Map<string, string>,
  triggerReconcile: (flakePath: string) => void,
  flakeUri: string,
  inviteCode: string,
  keyBlob: string,
  signature: string,
): Promise<{ name: string; namespace: string; flakeUri: string; identity: string }> {
  // Expand silo: shorthand
  const expandedUri = expandFlakeUri(flakeUri, config.siloHost);

  // Validate URI format
  if (!isValidFlakeUri(expandedUri)) {
    throw new Error(`invalid flake URI format: ${flakeUri}`);
  }

  // Check no existing SeedFlake already has this URI
  const existing = await listSeedFlakes(clients);
  for (const sf of existing) {
    if (sf.spec?.flakeUri === expandedUri) {
      throw new Error(`flake already registered: ${expandedUri}`);
    }
  }

  // Find SeedFlake with matching invite code
  let target: SeedFlake | null = null;
  for (const sf of existing) {
    if (sf.spec?.inviteCode === inviteCode && !sf.spec?.flakeUri) {
      target = sf;
      break;
    }
  }
  if (!target) {
    throw new Error("invalid or already-used invite code");
  }

  // Fetch flake source and verify caller's key is in .authorized_keys
  const authorizedKeys = await extractAuthorizedKeys(expandedUri, true);
  // Match keyBlob against authorized keys (type+blob, ignoring comments)
  const callerFound = authorizedKeys.some((line) => {
    const parts = line.split(/\s+/);
    return parts.length >= 2 && parts[1] === keyBlob;
  });
  if (!callerFound) {
    throw new Error("your key is not in the repo's .authorized_keys");
  }

  // Read .seed-identity from flake source
  const flakeStorePath = await getFlakeStorePath(expandedUri);
  let identity = "";
  let namespace: string;

  if (flakeStorePath) {
    const cid = await readSeedIdentity(flakeStorePath);
    if (cid) {
      identity = cid;

      // Verify plant signature if identity is present
      if (!signature) {
        throw new Error("repo has .seed-identity — signature required for plant (sign the invite code with your identity key)");
      }
      // Signature may be base64-encoded (shell transport) or raw armored
      const decodedSig = signature.startsWith("-----BEGIN SSH SIGNATURE-----")
        ? signature
        : Buffer.from(signature, "base64").toString("utf-8");
      if (!verifyPlantSignature(inviteCode, decodedSig, identity)) {
        throw new Error("plant signature verification failed — signature must be created with the private key that generated .seed-identity");
      }

      // Check no existing SeedFlake already has this identity
      for (const sf of existing) {
        if (sf.spec?.identity === identity && sf.metadata?.name !== target.metadata?.name) {
          throw new Error(`identity already registered: ${identity.slice(0, 24)}...`);
        }
      }
    }
  }

  // Derive namespace: from identity if present, otherwise from URI
  if (identity) {
    namespace = deriveNamespaceFromIdentity(identity);
  } else {
    namespace = deriveNamespace(expandedUri);
  }

  // Claim the invite: set flakeUri, identity, clear inviteCode (read-then-replace)
  const sfName = target.metadata!.name!;
  target.spec.flakeUri = expandedUri;
  target.spec.identity = identity;
  target.spec.inviteCode = "";
  await clients.custom.replaceClusterCustomObject({
    group: "seed.loom.farm",
    version: "v1alpha1",
    plural: "seedflakes",
    name: sfName,
    body: target,
  });

  // Set status
  await updateSeedFlakeStatus(clients, sfName, {
    namespace,
    state: "active",
    generation: "",
    lastReconciled: "",
  });

  // Register in flake states
  if (!flakeStates.has(expandedUri)) {
    flakeStates.set(expandedUri, {
      flakePath: expandedUri,
      namespace,
      identity,
      desired: null,
      reconciling: false,
    });
    namespaceToFlake.set(namespace, expandedUri);
    log("controller", `planted ${expandedUri} → ${namespace}`);

    // Update valid namespaces for API routing
    updateValidNamespaces(new Set([...flakeStates.values()].map((fs) => fs.namespace)));
    // Update ACME namespaces if enabled
    if (config.acmeEnabled) {
      updateAcmeNamespaces(new Set([...flakeStates.values()].map((fs) => fs.namespace)));
    }

    // Ensure namespace exists
    try {
      await clients.core.readNamespace({ name: namespace });
    } catch {
      await clients.core.createNamespace({
        body: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: namespace,
            labels: { [LABELS.MANAGED_BY]: MANAGED_BY_VALUE },
            annotations: { [ANNOTATIONS.FLAKE_URI]: expandedUri },
          },
        },
      });
    }

    // Trigger reconciliation for the new flake
    triggerReconcile(expandedUri);
  }

  return { name: sfName, namespace, flakeUri: expandedUri, identity };
}

/**
 * Get the store path of a flake's source tree.
 * Used to read .seed-identity and .authorized_keys from the flake root.
 */
async function getFlakeStorePath(flakePath: string): Promise<string | null> {
  try {
    const args = ["flake", "metadata", flakePath, "--json", "--refresh"];
    const { stdout } = await execFileAsync("nix", args, { timeout: 60_000 });
    const meta = JSON.parse(stdout);
    return meta.path || null;
  } catch {
    return null;
  }
}

/**
 * Handle a replant request: change flake URI for an identity-based SeedFlake.
 * Verifies .seed-identity matches and caller's key is in new repo's .authorized_keys.
 */
async function handleReplant(
  clients: ReturnType<typeof makeClients>,
  config: ControllerConfig,
  flakeStates: Map<string, FlakeState>,
  namespaceToFlake: Map<string, string>,
  triggerReconcile: (flakePath: string) => void,
  identity: string,
  newFlakeUri: string,
  keyBlob: string,
): Promise<{ name: string; namespace: string; flakeUri: string; identity: string }> {
  // Validate identity CID
  if (!isValidIpnsCid(identity)) {
    throw new Error("invalid IPNS CID format");
  }

  // Expand silo: shorthand
  const expandedUri = expandFlakeUri(newFlakeUri, config.siloHost);

  // Validate URI format
  if (!isValidFlakeUri(expandedUri)) {
    throw new Error(`invalid flake URI format: ${newFlakeUri}`);
  }

  // Find SeedFlake with matching identity
  const existing = await listSeedFlakes(clients);
  let target: SeedFlake | null = null;
  for (const sf of existing) {
    if (sf.spec?.identity === identity) {
      target = sf;
      break;
    }
  }
  if (!target) {
    throw new Error("no SeedFlake found with this identity");
  }

  const sfName = target.metadata!.name!;
  const oldUri = target.spec.flakeUri;
  const namespace = target.status?.namespace || "";
  if (!namespace) {
    throw new Error("SeedFlake has no namespace in status");
  }

  // Fetch new flake source
  const newStorePath = await getFlakeStorePath(expandedUri);
  if (!newStorePath) {
    throw new Error(`could not fetch flake source: ${expandedUri}`);
  }

  // Verify .seed-identity in new repo matches
  const newIdentity = await readSeedIdentity(newStorePath);
  if (newIdentity !== identity) {
    throw new Error(".seed-identity in new repo does not match (expected same IPNS CID)");
  }

  // Verify caller's key is in new repo's .authorized_keys
  const authorizedKeys = await extractAuthorizedKeys(expandedUri, true);
  const callerFound = authorizedKeys.some((line) => {
    const parts = line.split(/\s+/);
    return parts.length >= 2 && parts[1] === keyBlob;
  });
  if (!callerFound) {
    throw new Error("your key is not in the new repo's .authorized_keys");
  }

  // Update spec.flakeUri (identity and namespace unchanged)
  target.spec.flakeUri = expandedUri;
  await clients.custom.replaceClusterCustomObject({
    group: "seed.loom.farm",
    version: "v1alpha1",
    plural: "seedflakes",
    name: sfName,
    body: target,
  });

  log("controller", `replanted ${sfName}: ${oldUri} → ${expandedUri} (identity preserved)`);

  // Re-key flakeStates: remove old URI, add new
  if (oldUri && flakeStates.has(oldUri)) {
    flakeStates.delete(oldUri);
  }
  flakeStates.set(expandedUri, {
    flakePath: expandedUri,
    namespace,
    identity,
    desired: null,
    reconciling: false,
  });
  namespaceToFlake.set(namespace, expandedUri);

  // Update valid namespaces and ACME
  updateValidNamespaces(new Set([...flakeStates.values()].map((fs) => fs.namespace)));
  if (config.acmeEnabled) {
    updateAcmeNamespaces(new Set([...flakeStates.values()].map((fs) => fs.namespace)));
  }

  // Trigger reconciliation with new URI
  triggerReconcile(expandedUri);

  return { name: sfName, namespace, flakeUri: expandedUri, identity };
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
      identity: "", // Bootstrap flakes use URI-derived namespaces (no identity yet)
      desired: null,
      reconciling: false,
    });
    namespaceToFlake.set(namespace, flakePath);
    log("controller", `registered flake ${flakePath} → namespace ${namespace}`);
  }

  // Load active SeedFlakes from CRDs
  try {
    const newPaths = await loadSeedFlakes(clients, flakeStates, namespaceToFlake);
    if (newPaths.length > 0) {
      log("controller", `loaded ${newPaths.length} SeedFlake(s) from CRDs`);
    }
  } catch (err) {
    log("controller", `SeedFlake CRD load failed (CRD may not exist yet): ${err}`);
  }

  if (flakeStates.size === 0) {
    log("controller", "warning: no flakes registered (SEED_FLAKE_PATHS empty and no SeedFlakes)");
  }

  // Load pdns API key for DNS auto-registration
  let pdnsApiKey = "";
  if (config.pdnsApiUrl && config.pdnsApiKeyFile) {
    try {
      pdnsApiKey = await loadPdnsApiKey(config.pdnsApiKeyFile);
      log("controller", "DNS auto-registration enabled");
    } catch (err) {
      log("controller", `DNS auto-registration disabled: ${err}`);
    }
  }

  // Initialize ACME endpoint
  if (config.acmeEnabled && config.acmeAccountKeyFile && pdnsApiKey) {
    try {
      const webhookPort = parseInt(process.env["SEED_WEBHOOK_PORT"] || "9876", 10);
      await initAcme({
        baseUrl: `https://seed-controller.seed-system.svc.cluster.local:${webhookPort}`,
        leDirectoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        accountKeyFile: config.acmeAccountKeyFile,
        pdnsApiUrl: config.pdnsApiUrl,
        pdnsApiKey: pdnsApiKey,
        pdnsZone: config.pdnsZone,
        instanceDomain: config.instanceDomain,
        validNamespaces: new Set([...flakeStates.values()].map((fs) => fs.namespace)),
        validZones: new Set(),
      });
      log("controller", "ACME endpoint enabled");
    } catch (err) {
      log("controller", `ACME initialization failed: ${err}`);
    }
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

  // Load platform CA certificate from cert-manager for seed trust
  let platformCACert = "";
  try {
    const secret = await clients.core.readNamespacedSecret({
      name: "seed-root-ca",
      namespace: "cert-manager",
    });
    const caCertB64 = secret.data?.["tls.crt"];
    if (caCertB64) {
      platformCACert = Buffer.from(caCertB64, "base64").toString("utf-8");
      log("controller", "loaded platform CA certificate from cert-manager/seed-root-ca");
    } else {
      log("controller", "warning: seed-root-ca secret exists but has no tls.crt");
    }
  } catch (err) {
    log("controller", `platform CA not available (cert-manager may not be deployed): ${err}`);
  }

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
    await configureMetalLB(clients, config.ipv4Address, config.ipv6Block, readBGPConfig());
  } catch (err) {
    log("controller", `MetalLB configuration failed: ${err}`);
  }

  // Initialize management API
  const validNamespaces = new Set([...flakeStates.values()].map((fs) => fs.namespace));
  initApi(clients, kc, validNamespaces);

  // Webhook signaling: per-flake refresh tracking.
  const pendingRefresh = new Set<string>(); // flakePaths waiting to reconcile
  let webhookResolve: (() => void) | null = null;

  function triggerReconcile(flakePath: string): void {
    pendingRefresh.add(flakePath);
    if (webhookResolve) {
      webhookResolve();
      webhookResolve = null;
    }
  }

  if (config.webhookSecretFile || process.env["SEED_WEBHOOK_PORT"]) {
    const port = parseInt(process.env["SEED_WEBHOOK_PORT"] || "9876", 10);
    const tlsCertFile = process.env["SEED_TLS_CERT_FILE"] || "/etc/seed/tls/tls.crt";
    const tlsKeyFile = process.env["SEED_TLS_KEY_FILE"] || "/etc/seed/tls/tls.key";
    // Webhook matches against all registered flake paths (bootstrap + SeedFlakes)
    await startWebhookServer(port, config.webhookSecretFile, flakeStates, triggerReconcile, {
      certFile: tlsCertFile,
      keyFile: tlsKeyFile,
    });
  }

  // Wire up plant and replant handlers for the API
  setPlantHandler(async (flakeUri, inviteCode, keyBlob, signature) => {
    return handlePlant(clients, config, flakeStates, namespaceToFlake, triggerReconcile, flakeUri, inviteCode, keyBlob, signature);
  });
  setReplantHandler(async (identity, newFlakeUri, keyBlob) => {
    return handleReplant(clients, config, flakeStates, namespaceToFlake, triggerReconcile, identity, newFlakeUri, keyBlob);
  });

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

    // Initialize reconcile status — preserve commit from last successful deploy
    const rev = await getFlakeRevision(flakePath);
    const shortRev = rev ? rev.slice(0, 7) : "";
    const prev = getReconcileStatus(namespace);
    const rStatus: ReconcileStatus = {
      phase: "evaluating",
      generation: prev?.generation || "",
      commit: prev?.commit || "",
      buildCommit: shortRev,
      startedAt: new Date().toISOString(),
      finishedAt: prev?.finishedAt || "",
      error: "",
      instances: {},
    };
    updateReconcileStatus(namespace, rStatus);

    try {
      // List instances from flake
      const instanceNames = await listInstances(flakePath, useRefresh);

      // Mark all instances as pending build
      for (const name of instanceNames) {
        rStatus.instances[name] = { phase: "pending", error: "" };
      }
      rStatus.phase = "building";
      updateReconcileStatus(namespace, rStatus);

      // Build all instances
      let buildResults: Map<string, BuildResult>;

      if (config.poolManagerUrl) {
        // Use pool manager VMs (hardware-isolated nix eval/build)
        buildResults = await runViaPoolManager(
          config.poolManagerUrl,
          flakePath,
          instanceNames,
          useRefresh,
        );
      } else if (config.builderImage) {
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
          rStatus.instances[name] = { phase: "building", error: "" };
          updateReconcileStatus(namespace, rStatus);
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

      // Mark all instances as built
      for (const name of buildResults.keys()) {
        rStatus.instances[name] = { phase: "done", error: "" };
      }
      rStatus.phase = "applying";
      updateReconcileStatus(namespace, rStatus);

      // Compute generation
      const generation = computeGeneration(
        new Map([...buildResults].map(([name, r]) => [name, r.imagePath])),
      );

      // Read route configs from flake
      let ipv4Config: IPv4Config | null = null;
      let ipv6Config: IPv6Config | null = null;
      try {
        ipv4Config = (await nixEvalJson(
          `${flakePath}#seed.ipv4`,
          useRefresh,
        )) as IPv4Config;
      } catch { /* no seed.ipv4 output */ }
      try {
        ipv6Config = (await nixEvalJson(
          `${flakePath}#seed.ipv6`,
          useRefresh,
        )) as IPv6Config;
      } catch { /* no seed.ipv6 output */ }

      // Read combine.domains from flake
      let combineConfig: CombineConfig | null = null;
      try {
        combineConfig = (await nixEvalJson(
          `${flakePath}#combine`,
          useRefresh,
        )) as CombineConfig;
      } catch { /* no combine output */ }

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
      const webhookPort = parseInt(process.env["SEED_WEBHOOK_PORT"] || "9876", 10);
      const acmeUrl = config.acmeEnabled
        ? `https://seed-controller.seed-system.svc.cluster.local:${webhookPort}/acme/directory`
        : undefined;

      const desired = renderDesiredState(
        namespace,
        config.swtpmEnabled,
        config.ipv4Address,
        config.poolManagerUrl,
        buildResults,
        ipv4Config,
        ipv6Config,
        hostTaskStatuses,
        acmeUrl,
        config.instanceDomain,
        combineConfig?.domains,
      );

      // Apply desired state (SeedHostTasks already applied, skipped inside)
      await applyDesiredState(clients, desired, platformCACert);

      // Reap resources not in desired state
      await reapOldResources(clients, namespace, desired);

      fs.desired = desired;

      // Update SeedFlake status if this flake came from a CRD
      try {
        const seedFlakes = await listSeedFlakes(clients);
        for (const sf of seedFlakes) {
          if (sf.spec?.flakeUri === flakePath && sf.metadata?.name) {
            await updateSeedFlakeStatus(clients, sf.metadata.name, {
              namespace,
              state: "active",
              generation,
              lastReconciled: new Date().toISOString(),
            });
            break;
          }
        }
      } catch (err) {
        log("controller", `SeedFlake status update failed: ${err}`, flakePath);
      }

      log("controller", `reconciliation complete (generation=${generation})`, flakePath);

      // Mark reconcile status complete — promote buildCommit to commit
      rStatus.phase = "complete";
      rStatus.generation = generation.slice(0, 12);
      rStatus.commit = rStatus.buildCommit;
      rStatus.buildCommit = "";
      rStatus.finishedAt = new Date().toISOString();
      rStatus.error = "";
      updateReconcileStatus(namespace, rStatus);

      // Update ACME valid zones from ZoneReady SeedDomains
      if (config.acmeEnabled) {
        try {
          const domains = await clients.custom.listClusterCustomObject({
            group: "seed.loom.farm",
            version: "v1alpha1",
            plural: "seeddomains",
          }) as { items: SeedDomain[] };
          const zones = new Set(
            domains.items
              .filter((d) => d.status?.zoneReady)
              .map((d) => d.spec.name),
          );
          updateAcmeValidZones(zones);
        } catch { /* SeedDomain CRD may not exist */ }
      }
    } catch (err) {
      // Mark reconcile status as failed
      rStatus.phase = "failed";
      rStatus.finishedAt = new Date().toISOString();
      rStatus.error = err instanceof Error ? err.message : String(err);
      updateReconcileStatus(namespace, rStatus);
      throw err;
    } finally {
      fs.reconciling = false;
    }
  }

  // Startup: always reconcile all flakes to ensure desired state is correct.
  // Errors in one flake must not prevent other flakes from reconciling.
  for (const [flakePath, fs] of flakeStates) {
    try {
      await reconcile(flakePath, fs.namespace, false);
    } catch (err) {
      log("controller", `reconciliation failed (will retry on next webhook): ${err}`, flakePath);
    }
  }

  // Build initial key index from all flakes
  try {
    const index = await buildKeyIndex(flakeStates, false);
    updateKeyIndex(index);
  } catch (err) {
    log("controller", `initial key index build failed: ${err}`);
  }

  // Start k8s API watches for drift correction (cluster-wide).
  startWatches(kc, clients, flakeStates, namespaceToFlake);

  // Start DNS reconciler — watches SeedDNSRecord CRDs and syncs to pdns.
  // Replaces the old registerInstanceDNS polling + 60s periodic timer.
  if (pdnsApiKey && config.pdnsApiUrl) {
    startDNSReconciler(kc, clients.core, clients.custom, config.pdnsApiUrl, pdnsApiKey, config.pdnsZone);
    startDomainController(kc, clients.core, clients.custom, config.pdnsApiUrl, pdnsApiKey, config.namesiloApiKeyFile);
  }

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
      try {
        await reconcile(flakePath, fs.namespace, true);
      } catch (err) {
        log("controller", `reconciliation failed: ${err}`, flakePath);
      }
    }

    // Rebuild key index after reconciliation (keys may have changed)
    try {
      const index = await buildKeyIndex(flakeStates, true);
      updateKeyIndex(index);
    } catch (err) {
      log("controller", `key index rebuild failed: ${err}`);
    }
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
