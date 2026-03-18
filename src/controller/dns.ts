// DNS auto-registration — AAAA records in PowerDNS for seed instances.
//
// After reconciliation, the controller reads assigned IPv6 addresses from
// LoadBalancer service status and creates/updates AAAA records in pdns.
// Record format: <instance>.<namespace>.seed.loom.farm → IPv6 address.

import { log } from "../shared/kube.js";
import { readFile } from "node:fs/promises";

interface RRSet {
  name: string;
  type: string;
  ttl: number;
  changetype: "REPLACE" | "DELETE";
  records: { content: string; disabled: boolean }[];
}

/** Load the pdns API key from a file path. */
export async function loadPdnsApiKey(keyFile: string): Promise<string> {
  const key = (await readFile(keyFile, "utf-8")).trim();
  if (!key) throw new Error(`Empty pdns API key file: ${keyFile}`);
  return key;
}

/**
 * Register AAAA records for instances with assigned IPv6 LoadBalancer IPs.
 *
 * Takes a map of instance name → IPv6 address(es) and creates/updates
 * AAAA records at <instance>.<namespace>.<instanceDomain>.
 */
export async function registerDNSRecords(
  pdnsApiUrl: string,
  pdnsApiKey: string,
  zone: string,
  namespace: string,
  instanceDomain: string,
  instanceIPs: Map<string, string[]>,
): Promise<void> {
  if (instanceIPs.size === 0) return;

  const rrsets: RRSet[] = [];

  for (const [instance, ips] of instanceIPs) {
    if (ips.length === 0) continue;

    const fqdn = `${instance}.${namespace}.${instanceDomain}`;
    // Ensure trailing dot for pdns
    const name = fqdn.endsWith(".") ? fqdn : `${fqdn}.`;

    rrsets.push({
      name,
      type: "AAAA",
      ttl: 60,
      changetype: "REPLACE",
      records: ips.map((ip) => ({ content: ip, disabled: false })),
    });
  }

  if (rrsets.length === 0) return;

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
    log("dns", `pdns API error (${resp.status}): ${body}`);
    throw new Error(`pdns PATCH failed: ${resp.status}`);
  }

  for (const [instance, ips] of instanceIPs) {
    if (ips.length > 0) {
      log("dns", `registered ${instance}.${namespace}.${instanceDomain} → ${ips.join(", ")}`);
    }
  }
}

/**
 * Delete AAAA records for instances that no longer exist.
 */
export async function deleteDNSRecords(
  pdnsApiUrl: string,
  pdnsApiKey: string,
  zone: string,
  namespace: string,
  instanceDomain: string,
  instances: string[],
): Promise<void> {
  if (instances.length === 0) return;

  const rrsets: RRSet[] = instances.map((instance) => {
    const fqdn = `${instance}.${namespace}.${instanceDomain}`;
    const name = fqdn.endsWith(".") ? fqdn : `${fqdn}.`;
    return {
      name,
      type: "AAAA",
      ttl: 60,
      changetype: "DELETE",
      records: [],
    };
  });

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
    log("dns", `pdns DELETE error (${resp.status}): ${body}`);
  }

  for (const instance of instances) {
    log("dns", `deleted ${instance}.${namespace}.${instanceDomain}`);
  }
}
