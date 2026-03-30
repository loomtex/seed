// NameSilo REST API client for domain registration and management.
// Docs: https://www.namesilo.com/api-reference

import { log } from "../shared/kube.js";

const API_BASE = "https://www.namesilo.com/api";
const COMPONENT = "namesilo";

export interface NameSiloConfig {
  apiKey: string;
}

interface NameSiloReply {
  code: number;
  detail: string;
}

/** Parse NameSilo JSON response — all responses have reply.code + reply.detail. */
function parseReply(data: Record<string, unknown>): NameSiloReply {
  const reply = (data as { reply?: { code?: number; detail?: string } }).reply;
  return {
    code: reply?.code ?? 999,
    detail: reply?.detail ?? "unknown",
  };
}

/** Check if a domain is available for registration. */
export async function checkAvailability(
  config: NameSiloConfig,
  domain: string,
): Promise<boolean> {
  const url = `${API_BASE}/checkRegisterAvailability?version=1&type=json`
    + `&key=${config.apiKey}&domains=${encodeURIComponent(domain)}`;
  const resp = await fetch(url);
  const data = await resp.json() as Record<string, unknown>;
  const reply = parseReply(data);
  if (reply.code !== 300) {
    log(COMPONENT, `availability check failed for ${domain}: ${reply.detail}`);
    return false;
  }
  // Available domains: reply.available.domain can be a string, an object
  // with { domain: "name", price: ... }, or an array of either.
  const available = (data as { reply?: { available?: { domain?: unknown } } })
    .reply?.available?.domain;
  if (!available) return false;
  const list = Array.isArray(available) ? available : [available];
  return list.some((d) => {
    const name = typeof d === "string" ? d
      : (d as Record<string, unknown>)?.domain ?? String(d);
    return String(name).toLowerCase() === domain.toLowerCase();
  });
}

/** Register a domain with NS delegation to our nameservers. */
export async function registerDomain(
  config: NameSiloConfig,
  domain: string,
  nameservers: string[] = ["ns1.loom.farm", "ns2.loom.farm"],
): Promise<{ success: boolean; message: string }> {
  const nsParams = nameservers.map((ns, i) => `&ns${i + 1}=${encodeURIComponent(ns)}`).join("");
  const url = `${API_BASE}/registerDomain?version=1&type=json`
    + `&key=${config.apiKey}`
    + `&domain=${encodeURIComponent(domain)}`
    + `&years=1`
    + nsParams
    + `&private=1&auto_renew=1`;

  const resp = await fetch(url);
  const data = await resp.json() as Record<string, unknown>;
  const reply = parseReply(data);

  if (reply.code === 300) {
    log(COMPONENT, `registered ${domain}`);
    return { success: true, message: "registered" };
  }

  log(COMPONENT, `registration failed for ${domain}: ${reply.detail} (code ${reply.code})`);
  return { success: false, message: `${reply.detail} (code ${reply.code})` };
}

/** Get domain info (nameservers, expiry, lock status). */
export async function getDomainInfo(
  config: NameSiloConfig,
  domain: string,
): Promise<{
  nameservers: string[];
  expires: string;
  locked: boolean;
  status: string;
} | null> {
  const url = `${API_BASE}/getDomainInfo?version=1&type=json`
    + `&key=${config.apiKey}&domain=${encodeURIComponent(domain)}`;
  const resp = await fetch(url);
  const data = await resp.json() as Record<string, unknown>;
  const reply = parseReply(data);

  if (reply.code !== 300) {
    log(COMPONENT, `getDomainInfo failed for ${domain}: ${reply.detail}`);
    return null;
  }

  // NameSilo returns nameservers as an array of { nameserver, position } objects
  const info = (data as {
    reply?: {
      nameservers?: { nameserver: string; position: number }[] | { nameserver: string; position: number };
      expires?: string;
      locked?: string;
      status?: string;
    };
  }).reply;

  const rawNs = info?.nameservers;
  const nsList = rawNs
    ? (Array.isArray(rawNs) ? rawNs : [rawNs])
    : [];
  const nameservers = nsList.map((ns) => ns.nameserver);

  return {
    nameservers,
    expires: info?.expires ?? "",
    locked: info?.locked === "Yes",
    status: info?.status ?? "",
  };
}

/** Update nameservers for a domain. */
export async function changeNameServers(
  config: NameSiloConfig,
  domain: string,
  nameservers: string[],
): Promise<boolean> {
  const nsParams = nameservers.map((ns, i) => `&ns${i + 1}=${encodeURIComponent(ns)}`).join("");
  const url = `${API_BASE}/changeNameServers?version=1&type=json`
    + `&key=${config.apiKey}&domain=${encodeURIComponent(domain)}`
    + nsParams;

  const resp = await fetch(url);
  const data = await resp.json() as Record<string, unknown>;
  const reply = parseReply(data);

  if (reply.code === 300) {
    log(COMPONENT, `updated nameservers for ${domain}`);
    return true;
  }

  log(COMPONENT, `changeNameServers failed for ${domain}: ${reply.detail}`);
  return false;
}

/** Add a DNSSEC DS record to the domain. */
export async function addDSRecord(
  config: NameSiloConfig,
  domain: string,
  ds: { keyTag: number; algorithm: number; digestType: number; digest: string },
): Promise<boolean> {
  const url = `${API_BASE}/dnsSecAddRecord?version=1&type=json`
    + `&key=${config.apiKey}&domain=${encodeURIComponent(domain)}`
    + `&digest=${encodeURIComponent(ds.digest)}`
    + `&digestType=${ds.digestType}`
    + `&algorithm=${ds.algorithm}`
    + `&keyTag=${ds.keyTag}`;

  const resp = await fetch(url);
  const data = await resp.json() as Record<string, unknown>;
  const reply = parseReply(data);

  if (reply.code === 300) {
    log(COMPONENT, `added DS record for ${domain}`);
    return true;
  }

  log(COMPONENT, `addDSRecord failed for ${domain}: ${reply.detail}`);
  return false;
}
