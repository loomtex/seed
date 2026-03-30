// DNS reconciler — watches SeedDNSRecord CRDs and syncs records to PowerDNS.
//
// Two reconciliation modes:
// 1. On CRD add/update/delete: debounced 2s, diffs against last-applied set
// 2. Periodic full-sync every 120s as safety net for pdns restarts
//
// Safety: only manages (name, type) pairs that have CRDs. ACME TXT records,
// SOA, NS, and glue records (managed by pdns-sync-zones) are untouched.

import * as k8s from "@kubernetes/client-node";
import { log } from "../shared/kube.js";
import { readFile } from "node:fs/promises";
import type { SeedDNSRecord, SeedDNSRecordStatus, SeedDomain } from "../shared/types.js";

const CRD_GROUP = "seed.loom.farm";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "seeddnsrecords";

/**
 * Blacklisted DNS name suffixes — never sync these to pdns.
 * Records with blacklisted names get an error status on the CRD.
 */
const DNS_NAME_BLACKLIST = [
  ".cluster.local.",
  ".svc.cluster.local.",
  ".local.",
  ".internal.",
];

/** Check if a DNS name matches any blacklisted suffix. */
function isDNSNameBlacklisted(fqdn: string): boolean {
  const normalized = fqdn.endsWith(".") ? fqdn : `${fqdn}.`;
  return DNS_NAME_BLACKLIST.some((suffix) => normalized.endsWith(suffix));
}

interface RRSet {
  name: string;
  type: string;
  ttl: number;
  changetype: "REPLACE" | "DELETE";
  records: { content: string; disabled: boolean }[];
}

/** Track what we last applied to pdns — for diffing deletions. */
interface AppliedRecord {
  name: string;
  type: string;
}

/** Load the pdns API key from a file path. */
export async function loadPdnsApiKey(keyFile: string): Promise<string> {
  const key = (await readFile(keyFile, "utf-8")).trim();
  if (!key) throw new Error(`Empty pdns API key file: ${keyFile}`);
  return key;
}

/**
 * Resolve a SeedDNSRecord's effective records.
 * For static records, returns spec.records directly.
 * For sourceRef records, reads the Service's LoadBalancer ingress IP.
 */
async function resolveRecords(
  core: k8s.CoreV1Api,
  record: SeedDNSRecord,
): Promise<{ content: string }[] | null> {
  if (record.spec.records && record.spec.records.length > 0) {
    return record.spec.records;
  }

  if (record.spec.sourceRef) {
    const ns = record.metadata?.namespace;
    if (!ns) return null;
    try {
      const svc = await core.readNamespacedService({
        name: record.spec.sourceRef.name,
        namespace: ns,
      });
      const ingress = svc.status?.loadBalancer?.ingress;
      if (ingress && ingress.length > 0) {
        const ips = ingress.map((i) => i.ip).filter((ip): ip is string => !!ip);
        if (ips.length > 0) {
          return ips.map((ip) => ({ content: ip }));
        }
      }
    } catch {
      // Service not found or not ready
    }
    return null; // IP not yet assigned
  }

  return null;
}

/**
 * Start the DNS reconciler.
 * Watches SeedDNSRecord CRDs across all namespaces, resolves records,
 * and syncs to PowerDNS via its HTTP API.
 */
export function startDNSReconciler(
  kc: k8s.KubeConfig,
  core: k8s.CoreV1Api,
  custom: k8s.CustomObjectsApi,
  pdnsApiUrl: string,
  pdnsApiKey: string,
  pdnsZone: string,
): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastApplied = new Set<string>(); // "name|type" keys
  let lastAppliedZones = new Map<string, string>(); // "name|type" → zone

  /** Load all SeedDomains and build a map of domain name → phase. */
  async function loadDomainPhases(): Promise<Map<string, string>> {
    const phases = new Map<string, string>();
    try {
      const result = await custom.listClusterCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        plural: "seeddomains",
      }) as { items: SeedDomain[] };
      for (const domain of result.items) {
        phases.set(domain.spec.name, domain.status?.phase ?? "Pending");
      }
    } catch {
      // CRD may not exist yet
    }
    return phases;
  }

  /** Determine which pdns zone a record belongs to. */
  function zoneForRecord(record: SeedDNSRecord): string {
    if (record.spec.domainRef?.name) {
      const domain = record.spec.domainRef.name;
      return domain.endsWith(".") ? domain : `${domain}.`;
    }
    return pdnsZone;
  }

  async function reconcile(): Promise<void> {
    try {
      // List all SeedDNSRecords across all namespaces
      const result = await custom.listClusterCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        plural: CRD_PLURAL,
      }) as { items: SeedDNSRecord[] };

      // Load domain phases for domainRef checks
      const domainPhases = await loadDomainPhases();

      const records = result.items;
      // Group rrsets by zone
      const rrsetsByZone = new Map<string, RRSet[]>();
      const currentKeys = new Set<string>();
      const statusUpdates: { record: SeedDNSRecord; status: SeedDNSRecordStatus }[] = [];

      // Resolve all records and build REPLACE rrsets
      for (const record of records) {
        const key = `${record.spec.name}|${record.spec.type}`;

        // Check blacklist — set error status and skip
        if (isDNSNameBlacklisted(record.spec.name)) {
          statusUpdates.push({
            record,
            status: {
              synced: false,
              message: `blacklisted domain: ${record.spec.name} — internal domains cannot have external DNS records`,
              lastSyncedAt: record.status?.lastSyncedAt || "",
            },
          });
          continue;
        }

        // Check domainRef — skip if domain zone not ready
        if (record.spec.domainRef?.name) {
          const phase = domainPhases.get(record.spec.domainRef.name);
          if (phase !== "ZoneReady") {
            statusUpdates.push({
              record,
              status: {
                synced: false,
                message: `waiting for domain ${record.spec.domainRef.name} zone (phase: ${phase ?? "unknown"})`,
                lastSyncedAt: record.status?.lastSyncedAt || "",
              },
            });
            continue;
          }
        }

        const resolved = await resolveRecords(core, record);

        if (resolved && resolved.length > 0) {
          currentKeys.add(key);
          const zone = zoneForRecord(record);
          if (!rrsetsByZone.has(zone)) rrsetsByZone.set(zone, []);
          rrsetsByZone.get(zone)!.push({
            name: record.spec.name,
            type: record.spec.type,
            ttl: record.spec.ttl,
            changetype: "REPLACE",
            records: resolved.map((r) => ({ content: r.content, disabled: false })),
          });
          statusUpdates.push({
            record,
            status: {
              synced: true,
              resolvedRecords: resolved,
              message: "",
              lastSyncedAt: new Date().toISOString(),
            },
          });
        } else {
          // Can't resolve yet — mark as pending
          statusUpdates.push({
            record,
            status: {
              synced: false,
              message: record.spec.sourceRef
                ? `waiting for LoadBalancer IP on Service/${record.spec.sourceRef.name}`
                : "no records to sync",
              lastSyncedAt: record.status?.lastSyncedAt || "",
            },
          });
        }
      }

      // Compute DELETE rrsets for records removed since last sync
      for (const key of lastApplied) {
        if (!currentKeys.has(key)) {
          const [name, type] = key.split("|");
          // Determine zone for deletion — check lastAppliedZones
          const zone = lastAppliedZones.get(key) || pdnsZone;
          if (!rrsetsByZone.has(zone)) rrsetsByZone.set(zone, []);
          rrsetsByZone.get(zone)!.push({
            name,
            type,
            ttl: 0,
            changetype: "DELETE",
            records: [],
          });
          log("dns", `deleting ${type} ${name}`);
        }
      }

      // Apply to pdns — one PATCH per zone
      let totalReplaced = 0;
      let totalDeleted = 0;
      for (const [zone, rrsets] of rrsetsByZone) {
        if (rrsets.length === 0) continue;
        const url = `${pdnsApiUrl}/api/v1/servers/localhost/zones/${zone}`;
        const resp = await fetch(url, {
          method: "PATCH",
          headers: {
            "X-API-Key": pdnsApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ rrsets }),
        });

        if (!resp.ok) {
          const body = await resp.text();
          log("dns", `pdns API error for zone ${zone} (${resp.status}): ${body}`);
          continue;
        }

        totalReplaced += rrsets.filter((r) => r.changetype === "REPLACE").length;
        totalDeleted += rrsets.filter((r) => r.changetype === "DELETE").length;
      }

      if (totalReplaced > 0 || totalDeleted > 0) {
        log("dns", `synced ${totalReplaced} record(s), deleted ${totalDeleted} across ${rrsetsByZone.size} zone(s)`);
      }

      lastApplied = currentKeys;
      // Track which zone each key was applied to (for deletion routing)
      lastAppliedZones.clear();
      for (const [zone, rrsets] of rrsetsByZone) {
        for (const rrset of rrsets) {
          if (rrset.changetype === "REPLACE") {
            lastAppliedZones.set(`${rrset.name}|${rrset.type}`, zone);
          }
        }
      }

      // Update CRD statuses
      for (const { record, status } of statusUpdates) {
        const name = record.metadata?.name;
        const ns = record.metadata?.namespace;
        if (!name || !ns) continue;
        try {
          const existing = await custom.getNamespacedCustomObject({
            group: CRD_GROUP,
            version: CRD_VERSION,
            namespace: ns,
            plural: CRD_PLURAL,
            name,
          }) as SeedDNSRecord;
          existing.status = status;
          await custom.replaceNamespacedCustomObjectStatus({
            group: CRD_GROUP,
            version: CRD_VERSION,
            namespace: ns,
            plural: CRD_PLURAL,
            name,
            body: existing,
          });
        } catch (err) {
          log("dns", `status update failed for ${name}: ${err}`);
        }
      }
    } catch (err) {
      log("dns", `reconcile error: ${err}`);
    }
  }

  function scheduleReconcile(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reconcile();
    }, 2_000);
  }

  // Set up informer for SeedDNSRecords
  const listFn = async (): Promise<k8s.KubernetesListObject<SeedDNSRecord>> =>
    custom.listClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CRD_PLURAL,
    }) as Promise<k8s.KubernetesListObject<SeedDNSRecord>>;

  const informer = k8s.makeInformer<SeedDNSRecord>(
    kc,
    `/apis/${CRD_GROUP}/${CRD_VERSION}/${CRD_PLURAL}`,
    listFn,
  );

  informer.on("add", () => scheduleReconcile());
  informer.on("update", () => scheduleReconcile());
  informer.on("delete", () => scheduleReconcile());
  informer.on("error", (err) => {
    log("dns", `informer error: ${err}`);
    setTimeout(() => informer.start(), 5_000);
  });
  informer.on("connect", () => {
    log("dns", "informer connected");
  });

  informer.start();

  // Watch SeedDomains — re-reconcile when domain phases change (e.g. ZoneReady)
  const domainListFn = async (): Promise<k8s.KubernetesListObject<SeedDomain>> =>
    custom.listClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: "seeddomains",
    }) as Promise<k8s.KubernetesListObject<SeedDomain>>;

  const domainInformer = k8s.makeInformer<SeedDomain>(
    kc,
    `/apis/${CRD_GROUP}/${CRD_VERSION}/seeddomains`,
    domainListFn,
  );

  domainInformer.on("update", () => scheduleReconcile());
  domainInformer.on("error", (err) => {
    log("dns", `domain informer error: ${err}`);
    setTimeout(() => domainInformer.start(), 5_000);
  });

  domainInformer.start();

  // Also watch Services for LoadBalancer IP assignments
  const svcListFn = async (): Promise<k8s.KubernetesListObject<k8s.V1Service>> =>
    core.listServiceForAllNamespaces({
      labelSelector: "seed.loom.farm/service-type=ingress",
    }) as Promise<k8s.KubernetesListObject<k8s.V1Service>>;

  const svcInformer = k8s.makeInformer<k8s.V1Service>(
    kc,
    `/api/v1/services`,
    svcListFn,
    "seed.loom.farm/service-type=ingress",
  );

  svcInformer.on("update", () => scheduleReconcile());
  svcInformer.on("error", (err) => {
    log("dns", `service informer error: ${err}`);
    setTimeout(() => svcInformer.start(), 5_000);
  });

  svcInformer.start();

  // Periodic full-sync every 120s (safety net for pdns restarts)
  setInterval(() => reconcile(), 120_000);

  // Initial reconcile
  reconcile();

  log("dns", "reconciler started (watching SeedDNSRecords + ingress Services)");
}
