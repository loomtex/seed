// Domain controller — watches SeedDomain CRDs and drives the registration +
// zone lifecycle state machine.
//
// State flow:
//   Pending → Registering → Registered → Delegating → Delegated → ZoneReady
//
// For pre-owned domains (register=false):
//   Pending → Delegated → ZoneReady
//
// On any error, phase moves to Error with a message. The controller retries
// on the next reconcile cycle (periodic or informer-triggered).

import * as k8s from "@kubernetes/client-node";
import { log, recordEvent } from "../shared/kube.js";
import type { SeedDomain, SeedDomainStatus, SeedDomainPhase } from "../shared/types.js";
import {
  checkAvailability,
  registerDomain,
  getDomainInfo,
  changeNameServers,
  type NameSiloConfig,
} from "./namesilo.js";

const CRD_GROUP = "seed.loom.farm";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "seeddomains";
const COMPONENT = "domain";

const PLATFORM_NAMESERVERS = ["ns1.loom.farm", "ns2.loom.farm"];

/** SOA and NS rrsets that every zone must have. */
function requiredRrsets(fqdn: string): object[] {
  return [
    {
      name: fqdn,
      type: "SOA",
      ttl: 300,
      changetype: "REPLACE",
      records: [{
        content: `ns1.loom.farm. hostmaster.loom.farm. ${soaSerial()} 10800 3600 604800 300`,
        disabled: false,
      }],
    },
    {
      name: fqdn,
      type: "NS",
      ttl: 300,
      changetype: "REPLACE",
      records: PLATFORM_NAMESERVERS.map((ns) => ({
        content: ns.endsWith(".") ? ns : `${ns}.`,
        disabled: false,
      })),
    },
  ];
}

/** Ensure a zone has SOA and NS records, patching them in if missing. */
async function ensureZoneHealthy(
  pdnsApiUrl: string,
  pdnsApiKey: string,
  fqdn: string,
): Promise<boolean> {
  const url = `${pdnsApiUrl}/api/v1/servers/localhost/zones/${fqdn}`;
  const resp = await fetch(url, {
    headers: { "X-API-Key": pdnsApiKey },
  });
  if (!resp.ok) return false;

  const zone = await resp.json() as { rrsets?: { type: string }[] };
  const types = new Set((zone.rrsets ?? []).map((r) => r.type));
  if (types.has("SOA") && types.has("NS")) return true;

  log(COMPONENT, `zone ${fqdn} missing SOA/NS — patching`);
  const patchResp = await fetch(url, {
    method: "PATCH",
    headers: {
      "X-API-Key": pdnsApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rrsets: requiredRrsets(fqdn) }),
  });

  if (patchResp.ok) {
    log(COMPONENT, `repaired SOA/NS for ${fqdn}`);
    return true;
  }
  const body = await patchResp.text();
  log(COMPONENT, `failed to repair ${fqdn}: ${patchResp.status} ${body}`);
  return false;
}

/** Create a zone in PowerDNS via its HTTP API, or repair it if SOA/NS are missing. */
async function createPdnsZone(
  pdnsApiUrl: string,
  pdnsApiKey: string,
  zoneName: string,
): Promise<boolean> {
  const fqdn = zoneName.endsWith(".") ? zoneName : `${zoneName}.`;
  const url = `${pdnsApiUrl}/api/v1/servers/localhost/zones`;

  // Check if zone already exists
  const checkResp = await fetch(`${url}/${fqdn}`, {
    headers: { "X-API-Key": pdnsApiKey },
  });
  if (checkResp.ok) {
    // Zone exists — ensure it has SOA and NS records
    return ensureZoneHealthy(pdnsApiUrl, pdnsApiKey, fqdn);
  }

  // Create the zone
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "X-API-Key": pdnsApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: fqdn,
      kind: "Native",
      nameservers: PLATFORM_NAMESERVERS.map((ns) => (ns.endsWith(".") ? ns : `${ns}.`)),
      rrsets: requiredRrsets(fqdn),
    }),
  });

  if (resp.ok) {
    log(COMPONENT, `created zone ${fqdn}`);
    return true;
  }

  const body = await resp.text();
  log(COMPONENT, `failed to create zone ${fqdn}: ${resp.status} ${body}`);
  return false;
}

/** Generate a SOA serial (YYYYMMDDNN format). */
function soaSerial(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}01`;
}

/**
 * Reconcile a single SeedDomain through its state machine.
 * Returns the new status to apply.
 */
async function reconcileDomain(
  domain: SeedDomain,
  namesilo: NameSiloConfig | null,
  pdnsApiUrl: string,
  pdnsApiKey: string,
): Promise<SeedDomainStatus> {
  const name = domain.spec.name;
  const phase = domain.status?.phase ?? "Pending";
  const now = new Date().toISOString();

  const status: SeedDomainStatus = {
    phase,
    registered: domain.status?.registered ?? false,
    nsConfigured: domain.status?.nsConfigured ?? false,
    zoneReady: domain.status?.zoneReady ?? false,
    registrarDomainId: domain.status?.registrarDomainId,
    expiresAt: domain.status?.expiresAt,
    message: "",
    lastSyncedAt: now,
  };

  try {
    switch (phase) {
      case "Pending": {
        if (domain.spec.register) {
          if (!namesilo) {
            return { ...status, phase: "Error", message: "registrar API key not configured" };
          }
          // Check if we already own this domain (handles seed recreation,
          // controller restart, etc.)
          const info = await getDomainInfo(namesilo, name);
          if (info && info.status) {
            log(COMPONENT, `${name} already in our account (expires ${info.expires})`);
            return {
              ...status,
              phase: "Registered",
              registered: true,
              expiresAt: info.expires,
            };
          }
          // Not in our account — check availability
          const available = await checkAvailability(namesilo, name);
          if (!available) {
            return { ...status, phase: "Error", message: `${name} is not available for registration and not in our account` };
          }
          // Available — proceed to registration
          return { ...status, phase: "Registering" };
        }
        // Pre-owned domain — skip to Delegated (trust tenant set NS)
        log(COMPONENT, `${name} is pre-owned, skipping registration`);
        return { ...status, phase: "Delegated", registered: false, nsConfigured: true };
      }

      case "Registering": {
        if (!namesilo) {
          return { ...status, phase: "Error", message: "registrar API key not configured" };
        }
        const result = await registerDomain(namesilo, name, PLATFORM_NAMESERVERS);
        if (result.success) {
          return { ...status, phase: "Registered", registered: true };
        }
        // If registration failed because domain is already in our account,
        // treat as success (handles race conditions, retries, seed recreation)
        const info = await getDomainInfo(namesilo, name);
        if (info && info.status) {
          log(COMPONENT, `${name} registration returned error but domain is in our account`);
          return { ...status, phase: "Registered", registered: true, expiresAt: info.expires };
        }
        return { ...status, phase: "Error", message: `registration failed: ${result.message}` };
      }

      case "Registered": {
        // Verify/set nameservers
        if (!namesilo) {
          return { ...status, phase: "Error", message: "registrar API key not configured" };
        }
        const info = await getDomainInfo(namesilo, name);
        if (!info) {
          return { ...status, phase: "Error", message: "could not fetch domain info" };
        }

        status.expiresAt = info.expires;

        // Check if NS already correct
        const nsCorrect = PLATFORM_NAMESERVERS.every((ns) =>
          info.nameservers.some((existing) => existing.toLowerCase() === ns.toLowerCase()),
        );

        if (nsCorrect) {
          log(COMPONENT, `${name} NS already correct`);
          return { ...status, phase: "Delegated", nsConfigured: true };
        }

        // Set NS
        return { ...status, phase: "Delegating" };
      }

      case "Delegating": {
        if (!namesilo) {
          return { ...status, phase: "Error", message: "registrar API key not configured" };
        }
        const ok = await changeNameServers(namesilo, name, PLATFORM_NAMESERVERS);
        if (ok) {
          return { ...status, phase: "Delegated", nsConfigured: true };
        }
        return { ...status, phase: "Error", message: "failed to set nameservers" };
      }

      case "Delegated": {
        // Create zone in pdns
        const ok = await createPdnsZone(pdnsApiUrl, pdnsApiKey, name);
        if (ok) {
          log(COMPONENT, `${name} zone ready`);
          return { ...status, phase: "ZoneReady", zoneReady: true };
        }
        return { ...status, phase: "Error", message: "failed to create zone in pdns" };
      }

      case "ZoneReady": {
        // Verify zone health (SOA/NS present) — self-heal if missing
        const healthy = await ensureZoneHealthy(pdnsApiUrl, pdnsApiKey,
          name.endsWith(".") ? name : `${name}.`);
        if (!healthy) {
          return { ...status, phase: "Error", zoneReady: false, message: "zone missing SOA/NS and repair failed" };
        }
        // Refresh expiry if we have registrar access
        if (namesilo && domain.spec.register) {
          const info = await getDomainInfo(namesilo, name);
          if (info) {
            status.expiresAt = info.expires;
          }
        }
        return { ...status, zoneReady: true };
      }

      case "Error": {
        // Retry from the beginning
        log(COMPONENT, `${name} retrying from Pending (was: ${domain.status?.message})`);
        return { ...status, phase: "Pending", message: "" };
      }

      default:
        return status;
    }
  } catch (err) {
    return { ...status, phase: "Error", message: String(err) };
  }
}

/**
 * Start the domain controller.
 * Watches SeedDomain CRDs and drives each through its lifecycle.
 */
export function startDomainController(
  kc: k8s.KubeConfig,
  core: k8s.CoreV1Api,
  custom: k8s.CustomObjectsApi,
  pdnsApiUrl: string,
  pdnsApiKey: string,
  namesiloApiKeyFile: string,
): void {
  let namesiloConfig: NameSiloConfig | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Load API key
  if (namesiloApiKeyFile) {
    import("node:fs/promises").then(async ({ readFile }) => {
      try {
        const key = (await readFile(namesiloApiKeyFile, "utf-8")).trim();
        if (key) {
          namesiloConfig = { apiKey: key };
          log(COMPONENT, "loaded NameSilo API key");
        }
      } catch (err) {
        log(COMPONENT, `failed to load NameSilo API key: ${err}`);
      }
    });
  }

  async function reconcile(): Promise<void> {
    try {
      const result = await custom.listClusterCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        plural: CRD_PLURAL,
      }) as { items: SeedDomain[] };

      // Build conflict map: domain name → oldest CRD (by creation timestamp).
      // If two namespaces declare the same domain, only the first one wins.
      const domainOwner = new Map<string, { ns: string; created: string }>();
      for (const d of result.items) {
        const dName = d.spec.name;
        const dNs = d.metadata?.namespace ?? "";
        const dCreated = String(d.metadata?.creationTimestamp ?? "");
        const existing = domainOwner.get(dName);
        if (!existing || dCreated < existing.created) {
          domainOwner.set(dName, { ns: dNs, created: dCreated });
        }
      }

      for (const domain of result.items) {
        const name = domain.metadata?.name;
        const ns = domain.metadata?.namespace;
        if (!name || !ns) continue;

        // Conflict check: reject if another namespace owns this domain
        const owner = domainOwner.get(domain.spec.name);
        if (owner && owner.ns !== ns) {
          const prev = domain.status;
          const errMsg = `domain ${domain.spec.name} is already claimed by namespace ${owner.ns}`;
          if (prev?.phase !== "Error" || prev?.message !== errMsg) {
            try {
              const existing = await custom.getNamespacedCustomObject({
                group: CRD_GROUP,
                version: CRD_VERSION,
                namespace: ns,
                plural: CRD_PLURAL,
                name,
              }) as SeedDomain;
              existing.status = {
                phase: "Error",
                registered: false,
                nsConfigured: false,
                zoneReady: false,
                message: errMsg,
                lastSyncedAt: new Date().toISOString(),
              };
              await custom.replaceNamespacedCustomObjectStatus({
                group: CRD_GROUP,
                version: CRD_VERSION,
                namespace: ns,
                plural: CRD_PLURAL,
                name,
                body: existing,
              });
              log(COMPONENT, `${domain.spec.name}: conflict — ${errMsg}`);
            } catch (err) {
              log(COMPONENT, `conflict status update failed for ${name}: ${err}`);
            }
          }
          continue;
        }

        // Skip if already in terminal state and not due for refresh
        if (domain.status?.phase === "ZoneReady" && domain.status?.zoneReady) {
          // Refresh expiry every 24h
          const lastSync = domain.status.lastSyncedAt
            ? new Date(domain.status.lastSyncedAt).getTime()
            : 0;
          if (Date.now() - lastSync < 86_400_000) continue;
        }

        const newStatus = await reconcileDomain(
          domain,
          namesiloConfig,
          pdnsApiUrl,
          pdnsApiKey,
        );

        // Update status if changed
        const phaseChanged = newStatus.phase !== domain.status?.phase;
        const zoneChanged = newStatus.zoneReady !== domain.status?.zoneReady;
        if (phaseChanged || zoneChanged || newStatus.phase !== "ZoneReady") {
          try {
            const existing = await custom.getNamespacedCustomObject({
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace: ns,
              plural: CRD_PLURAL,
              name,
            }) as SeedDomain;
            existing.status = newStatus;
            await custom.replaceNamespacedCustomObjectStatus({
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace: ns,
              plural: CRD_PLURAL,
              name,
              body: existing,
            });
            if (phaseChanged) {
              log(COMPONENT, `${domain.spec.name}: ${domain.status?.phase ?? "new"} → ${newStatus.phase}`);
              // Emit k8s Event for phase transitions
              const eventType = newStatus.phase === "Error" ? "Warning" : "Normal";
              const reason = newStatus.phase === "Error" ? "ReconcileError" : `Phase${newStatus.phase}`;
              const msg = newStatus.message || `transitioned to ${newStatus.phase}`;
              await recordEvent(core, {
                apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
                kind: "SeedDomain",
                name,
                namespace: ns,
                uid: domain.metadata?.uid,
              }, eventType, reason, msg);
            }
          } catch (err) {
            log(COMPONENT, `status update failed for ${name}: ${err}`);
          }
        }
      }
    } catch (err) {
      log(COMPONENT, `reconcile error: ${err}`);
    }
  }

  function scheduleReconcile(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reconcile();
    }, 2_000);
  }

  // Set up informer
  const listFn = async (): Promise<k8s.KubernetesListObject<SeedDomain>> =>
    custom.listClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CRD_PLURAL,
    }) as Promise<k8s.KubernetesListObject<SeedDomain>>;

  const informer = k8s.makeInformer<SeedDomain>(
    kc,
    `/apis/${CRD_GROUP}/${CRD_VERSION}/${CRD_PLURAL}`,
    listFn,
  );

  informer.on("add", () => scheduleReconcile());
  informer.on("update", () => scheduleReconcile());
  informer.on("delete", () => scheduleReconcile());
  informer.on("error", (err) => {
    log(COMPONENT, `informer error: ${err}`);
    setTimeout(() => informer.start(), 5_000);
  });
  informer.on("connect", () => {
    log(COMPONENT, "informer connected");
  });

  informer.start();

  // Periodic reconcile every 60s — domains in non-terminal states need
  // to be driven through the state machine
  setInterval(() => reconcile(), 60_000);

  // Initial reconcile
  reconcile();

  log(COMPONENT, "controller started (watching SeedDomains)");
}
