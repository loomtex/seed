// ACME server for seed instances + Let's Encrypt DNS-01 proxy.
//
// The controller is both:
// - ACME server to instances (speaks RFC 8555)
// - ACME client to Let's Encrypt (DNS-01 via pdns API)
//
// Authorization model: no instance-facing challenge. The platform
// assigned the domain — the controller validates that the requested
// FQDN matches the caller's namespace. Network policy enforces
// namespace identity at the network level.
//
// State is in-memory — lost on restart. ACME clients handle this
// gracefully (retry / re-register).

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as jose from "jose";
import type { CryptoKey } from "jose";
import { log } from "../shared/kube.js";

// --- Types ---

interface AcmeAccount {
  id: string;
  jwk: jose.JWK;
  thumbprint: string;
}

interface AcmeOrder {
  id: string;
  accountId: string;
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  identifiers: Array<{ type: "dns"; value: string }>;
  authzId: string;
  finalize: string;
  certificate?: string;
}

export interface AcmeConfig {
  baseUrl: string;
  leDirectoryUrl: string;
  accountKeyFile: string;
  pdnsApiUrl: string;
  pdnsApiKey: string;
  pdnsZone: string;
  validNamespaces: Set<string>;
}

// --- State ---

let config: AcmeConfig | null = null;
const nonces = new Set<string>();
const accounts = new Map<string, AcmeAccount>(); // thumbprint → account
const accountsById = new Map<string, AcmeAccount>(); // id → account
const orders = new Map<string, AcmeOrder>();
const certs = new Map<string, string>(); // orderId → PEM chain

// LE client state
let leAccountKey: CryptoKey | null = null;
let leAccountUrl = "";
let leDirectory: Record<string, string> | null = null;

let idCounter = 0;
function nextId(): string {
  return `${Date.now()}-${++idCounter}`;
}

function freshNonce(): string {
  const nonce = randomBytes(16).toString("hex");
  nonces.add(nonce);
  return nonce;
}

function consumeNonce(nonce: string): boolean {
  return nonces.delete(nonce);
}

// --- Initialization ---

export async function initAcme(cfg: AcmeConfig): Promise<void> {
  config = cfg;
  const keyPem = await readFile(cfg.accountKeyFile, "utf-8");
  leAccountKey = await jose.importPKCS8(keyPem.trim(), "ES256", { extractable: true });
  log("acme", "ACME endpoint initialized");
}

export function updateAcmeNamespaces(namespaces: Set<string>): void {
  if (config) config.validNamespaces = namespaces;
}

// --- Domain validation ---

/** Validate that a domain is authorized for a known namespace.
 *  Accepted formats:
 *  - <instance>.<namespace>.<zone>  (e.g. web.s-gaydazldmnsg.loom.farm)
 *  - <zone> itself (e.g. loom.farm) — allowed for any known namespace
 *  - <sub>.<zone> (e.g. silo.loom.farm) — allowed for any known namespace
 */
function validateDomain(domain: string): boolean {
  if (!config) return false;

  const zone = config.pdnsZone.replace(/\.$/, "");

  // Exact zone match (apex domain)
  if (domain === zone) return config.validNamespaces.size > 0;

  const suffix = `.${zone}`;
  if (!domain.endsWith(suffix)) return false;

  const prefix = domain.slice(0, -suffix.length);
  const parts = prefix.split(".");

  // <instance>.<namespace>.zone — validate namespace
  if (parts.length === 2) {
    const [, namespace] = parts;
    return config.validNamespaces.has(namespace);
  }

  // <sub>.zone (e.g. silo.loom.farm) — allowed for any known namespace
  if (parts.length === 1) return config.validNamespaces.size > 0;

  return false;
}

// --- ACME request handler ---

export async function handleAcmeRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<boolean> {
  const url = req.url || "";
  if (!url.startsWith("/acme/")) return false;

  if (!config) {
    sendAcmeError(res, 503, "serverInternal", "ACME not initialized", freshNonce());
    return true;
  }

  const nonce = freshNonce();

  try {
    const pathname = url.split("?")[0];

    // Directory (GET or HEAD)
    if (pathname === "/acme/directory") {
      return handleDirectory(res, nonce);
    }

    // New nonce (HEAD or POST)
    if (pathname === "/acme/new-nonce") {
      res.writeHead(req.method === "HEAD" ? 200 : 204, {
        "Replay-Nonce": nonce,
        "Cache-Control": "no-store",
      });
      res.end();
      return true;
    }

    // All remaining endpoints require POST with JWS body
    if (req.method !== "POST") {
      sendAcmeError(res, 405, "malformed", "Method not allowed", nonce);
      return true;
    }

    const body = await readBody(req);
    let jws: any;
    try {
      jws = JSON.parse(body.toString());
    } catch {
      sendAcmeError(res, 400, "malformed", "Invalid JSON body", nonce);
      return true;
    }

    // Decode protected header
    let protectedHeader: any;
    try {
      protectedHeader = JSON.parse(
        Buffer.from(jws.protected, "base64url").toString(),
      );
    } catch {
      sendAcmeError(res, 400, "malformed", "Invalid protected header", nonce);
      return true;
    }

    // Verify and consume nonce
    if (!protectedHeader.nonce || !consumeNonce(protectedHeader.nonce)) {
      sendAcmeError(res, 400, "badNonce", "Invalid or expired nonce", nonce);
      return true;
    }

    // new-account uses jwk in header, everything else uses kid
    if (pathname === "/acme/new-account") {
      return await handleNewAccount(res, jws, protectedHeader, nonce);
    }

    // Resolve account from kid
    if (!protectedHeader.kid) {
      sendAcmeError(res, 400, "malformed", "Missing kid", nonce);
      return true;
    }

    const account = findAccountByKid(protectedHeader.kid);
    if (!account) {
      sendAcmeError(res, 401, "accountDoesNotExist", "Account not found", nonce);
      return true;
    }

    // Verify JWS signature with account's public key
    const pubKey = await jose.importJWK(account.jwk, protectedHeader.alg);
    try {
      await jose.flattenedVerify(jws, pubKey);
    } catch {
      sendAcmeError(res, 401, "unauthorized", "Invalid signature", nonce);
      return true;
    }

    // Decode payload (empty for POST-as-GET)
    const payloadStr = jws.payload
      ? Buffer.from(jws.payload, "base64url").toString()
      : "";
    const payload = payloadStr ? JSON.parse(payloadStr) : null;

    // Route to handler
    if (pathname === "/acme/new-order") {
      return await handleNewOrder(res, account, payload, nonce);
    }

    const orderMatch = pathname.match(/^\/acme\/order\/([^/]+)$/);
    if (orderMatch) {
      return handleOrderStatus(res, orderMatch[1], nonce);
    }

    const finalizeMatch = pathname.match(
      /^\/acme\/order\/([^/]+)\/finalize$/,
    );
    if (finalizeMatch) {
      return await handleFinalize(res, finalizeMatch[1], payload, nonce);
    }

    const certMatch = pathname.match(/^\/acme\/cert\/([^/]+)$/);
    if (certMatch) {
      return handleCertDownload(res, certMatch[1], nonce);
    }

    const authzMatch = pathname.match(/^\/acme\/authz\/([^/]+)$/);
    if (authzMatch) {
      return handleAuthz(res, authzMatch[1], nonce);
    }

    const challengeMatch = pathname.match(/^\/acme\/challenge\/([^/]+)$/);
    if (challengeMatch) {
      return handleChallenge(res, challengeMatch[1], nonce);
    }

    sendAcmeError(res, 404, "malformed", "Not found", nonce);
  } catch (err) {
    log("acme", `error handling ${req.method} ${url}: ${err}`);
    sendAcmeError(res, 500, "serverInternal", String(err), freshNonce());
  }

  return true;
}

// --- Directory ---

function handleDirectory(
  res: import("node:http").ServerResponse,
  nonce: string,
): boolean {
  const base = config!.baseUrl;
  sendJson(
    res,
    200,
    {
      newNonce: `${base}/acme/new-nonce`,
      newAccount: `${base}/acme/new-account`,
      newOrder: `${base}/acme/new-order`,
      meta: {
        website: "https://loom.farm",
      },
    },
    { "Replay-Nonce": nonce },
  );
  return true;
}

// --- Account ---

async function handleNewAccount(
  res: import("node:http").ServerResponse,
  jws: any,
  protectedHeader: any,
  nonce: string,
): Promise<boolean> {
  const jwk = protectedHeader.jwk;
  if (!jwk) {
    sendAcmeError(res, 400, "malformed", "Missing jwk in protected header", nonce);
    return true;
  }

  // Verify signature with provided JWK
  const alg = protectedHeader.alg;
  const pubKey = await jose.importJWK(jwk, alg);
  try {
    await jose.flattenedVerify(jws, pubKey);
  } catch {
    sendAcmeError(res, 401, "unauthorized", "Invalid signature", nonce);
    return true;
  }

  const thumbprint = await jose.calculateJwkThumbprint(jwk);

  // Existing account?
  const existing = accounts.get(thumbprint);
  if (existing) {
    sendJson(
      res,
      200,
      { status: "valid" },
      {
        "Replay-Nonce": nonce,
        Location: `${config!.baseUrl}/acme/account/${existing.id}`,
      },
    );
    return true;
  }

  // onlyReturnExisting check
  const payloadStr = jws.payload
    ? Buffer.from(jws.payload, "base64url").toString()
    : "";
  const payload = payloadStr ? JSON.parse(payloadStr) : null;
  if (payload?.onlyReturnExisting) {
    sendAcmeError(res, 400, "accountDoesNotExist", "Account not found", nonce);
    return true;
  }

  // Create new account
  const id = nextId();
  const account: AcmeAccount = { id, jwk, thumbprint };
  accounts.set(thumbprint, account);
  accountsById.set(id, account);

  log("acme", `new account ${id}`);

  sendJson(
    res,
    201,
    { status: "valid" },
    {
      "Replay-Nonce": nonce,
      Location: `${config!.baseUrl}/acme/account/${id}`,
    },
  );
  return true;
}

function findAccountByKid(kid: string): AcmeAccount | null {
  const match = kid.match(/\/acme\/account\/([^/]+)/);
  if (!match) return null;
  return accountsById.get(match[1]) || null;
}

// --- Order ---

async function handleNewOrder(
  res: import("node:http").ServerResponse,
  account: AcmeAccount,
  payload: any,
  nonce: string,
): Promise<boolean> {
  if (!payload?.identifiers?.length) {
    sendAcmeError(res, 400, "malformed", "Missing identifiers", nonce);
    return true;
  }

  for (const id of payload.identifiers) {
    if (id.type !== "dns") {
      sendAcmeError(res, 400, "unsupportedIdentifier", `Unsupported type: ${id.type}`, nonce);
      return true;
    }
    if (!validateDomain(id.value)) {
      sendAcmeError(res, 403, "unauthorized", `Domain ${id.value} not authorized for this namespace`, nonce);
      return true;
    }
  }

  const id = nextId();
  const authzId = `authz-${id}`;
  const base = config!.baseUrl;

  const order: AcmeOrder = {
    id,
    accountId: account.id,
    status: "ready", // Skip pending — platform already authorized
    identifiers: payload.identifiers,
    authzId,
    finalize: `${base}/acme/order/${id}/finalize`,
  };

  orders.set(id, order);

  log("acme", `new order ${id}: ${payload.identifiers.map((i: any) => i.value).join(", ")}`);

  sendJson(
    res,
    201,
    orderToJson(order),
    {
      "Replay-Nonce": nonce,
      Location: `${base}/acme/order/${id}`,
    },
  );
  return true;
}

function handleOrderStatus(
  res: import("node:http").ServerResponse,
  orderId: string,
  nonce: string,
): boolean {
  const order = orders.get(orderId);
  if (!order) {
    sendAcmeError(res, 404, "malformed", "Order not found", nonce);
    return true;
  }

  sendJson(res, 200, orderToJson(order), { "Replay-Nonce": nonce });
  return true;
}

function orderToJson(order: AcmeOrder): Record<string, unknown> {
  const base = config!.baseUrl;
  const body: Record<string, unknown> = {
    status: order.status,
    identifiers: order.identifiers,
    authorizations: [`${base}/acme/authz/${order.authzId}`],
    finalize: order.finalize,
  };
  if (order.certificate) body.certificate = order.certificate;
  return body;
}

// --- Finalize ---

async function handleFinalize(
  res: import("node:http").ServerResponse,
  orderId: string,
  payload: any,
  nonce: string,
): Promise<boolean> {
  const order = orders.get(orderId);
  if (!order) {
    sendAcmeError(res, 404, "malformed", "Order not found", nonce);
    return true;
  }

  if (order.status !== "ready") {
    sendAcmeError(res, 403, "orderNotReady", `Order status is ${order.status}`, nonce);
    return true;
  }

  if (!payload?.csr) {
    sendAcmeError(res, 400, "malformed", "Missing CSR", nonce);
    return true;
  }

  order.status = "processing";

  try {
    const domains = order.identifiers.map((id) => id.value);
    const csrDer = Buffer.from(payload.csr, "base64url");

    log("acme", `obtaining LE cert for ${domains.join(", ")}...`);
    const certPem = await obtainCertFromLE(domains, csrDer);

    certs.set(orderId, certPem);
    order.status = "valid";
    order.certificate = `${config!.baseUrl}/acme/cert/${orderId}`;

    log("acme", `cert issued for ${domains.join(", ")}`);

    sendJson(
      res,
      200,
      orderToJson(order),
      {
        "Replay-Nonce": nonce,
        Location: `${config!.baseUrl}/acme/order/${orderId}`,
      },
    );
  } catch (err) {
    order.status = "invalid";
    log("acme", `cert acquisition failed: ${err}`);
    sendAcmeError(res, 500, "serverInternal", `Certificate acquisition failed: ${err}`, nonce);
  }

  return true;
}

// --- Cert download ---

function handleCertDownload(
  res: import("node:http").ServerResponse,
  orderId: string,
  nonce: string,
): boolean {
  const certPem = certs.get(orderId);
  if (!certPem) {
    sendAcmeError(res, 404, "malformed", "Certificate not found", nonce);
    return true;
  }

  res.writeHead(200, {
    "Content-Type": "application/pem-certificate-chain",
    "Content-Length": String(Buffer.byteLength(certPem)),
    "Replay-Nonce": nonce,
  });
  res.end(certPem);
  return true;
}

// --- Authorization (always valid — platform-authorized) ---

function handleAuthz(
  res: import("node:http").ServerResponse,
  authzId: string,
  nonce: string,
): boolean {
  const orderId = authzId.replace("authz-", "");
  const order = orders.get(orderId);
  if (!order) {
    sendAcmeError(res, 404, "malformed", "Authorization not found", nonce);
    return true;
  }

  const base = config!.baseUrl;
  sendJson(
    res,
    200,
    {
      status: "valid",
      identifier: order.identifiers[0],
      challenges: [
        {
          type: "dns-01",
          status: "valid",
          url: `${base}/acme/challenge/challenge-${orderId}`,
          token: randomBytes(16).toString("base64url"),
        },
      ],
    },
    { "Replay-Nonce": nonce },
  );
  return true;
}

// --- Challenge (always valid) ---

function handleChallenge(
  res: import("node:http").ServerResponse,
  challengeId: string,
  nonce: string,
): boolean {
  sendJson(
    res,
    200,
    {
      type: "dns-01",
      status: "valid",
      url: `${config!.baseUrl}/acme/challenge/${challengeId}`,
      token: randomBytes(16).toString("base64url"),
    },
    { "Replay-Nonce": nonce },
  );
  return true;
}

// ===========================================================================
// LE ACME Client — obtains real certificates from Let's Encrypt via DNS-01
// ===========================================================================

async function getLeDirectory(): Promise<Record<string, string>> {
  if (leDirectory) return leDirectory;
  const resp = await fetch(config!.leDirectoryUrl);
  if (!resp.ok) throw new Error(`LE directory fetch failed: ${resp.status}`);
  leDirectory = (await resp.json()) as Record<string, string>;
  return leDirectory;
}

async function getLeNonce(): Promise<string> {
  const dir = await getLeDirectory();
  const resp = await fetch(dir.newNonce, { method: "HEAD" });
  const nonce = resp.headers.get("replay-nonce");
  if (!nonce) throw new Error("No nonce from LE");
  return nonce;
}

/**
 * Sign a JWS for LE ACME requests using the LE account key.
 * For newAccount: uses jwk in header. For everything else: uses kid.
 */
async function signLeJws(
  url: string,
  payload: unknown | null,
  nonce: string,
): Promise<string> {
  if (!leAccountKey) throw new Error("LE account key not loaded");

  // POST-as-GET: empty payload (base64url of empty bytes = "")
  const payloadBytes =
    payload !== null
      ? new TextEncoder().encode(JSON.stringify(payload))
      : new Uint8Array(0);

  const header: Record<string, unknown> = {
    alg: "ES256",
    nonce,
    url,
  };

  if (leAccountUrl) {
    header.kid = leAccountUrl;
  } else {
    header.jwk = await jose.exportJWK(leAccountKey);
    // Remove private key fields — ACME expects public JWK only
    delete (header.jwk as any).d;
  }

  const result = await new jose.FlattenedSign(payloadBytes)
    .setProtectedHeader(header as jose.JWSHeaderParameters)
    .sign(leAccountKey);

  return JSON.stringify(result);
}

/**
 * Make an authenticated POST request to LE.
 * Returns parsed JSON body and the new nonce from response headers.
 */
async function lePost(
  url: string,
  payload: unknown | null,
): Promise<{ status: number; headers: Headers; body: any }> {
  const nonce = await getLeNonce();
  const body = await signLeJws(url, payload, nonce);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/jose+json" },
    body,
  });

  const contentType = resp.headers.get("content-type") || "";
  const responseBody = contentType.includes("json")
    ? await resp.json()
    : await resp.text();

  return { status: resp.status, headers: resp.headers, body: responseBody };
}

/** Ensure the LE account exists (or find existing by key). */
async function ensureLeAccount(): Promise<void> {
  if (leAccountUrl) return;

  const dir = await getLeDirectory();
  const result = await lePost(dir.newAccount, {
    termsOfServiceAgreed: true,
  });

  leAccountUrl = result.headers.get("location") || "";
  if (!leAccountUrl) throw new Error("LE newAccount: no Location header");
  log("acme", `LE account: ${leAccountUrl}`);
}

/**
 * Obtain a certificate from Let's Encrypt via DNS-01.
 *
 * 1. Create LE order
 * 2. For each authorization: create _acme-challenge TXT record, validate
 * 3. Finalize with instance's CSR
 * 4. Download and return the PEM certificate chain
 */
async function obtainCertFromLE(
  domains: string[],
  csrDer: Buffer,
): Promise<string> {
  await ensureLeAccount();

  const dir = await getLeDirectory();

  // 1. Create order
  const orderResult = await lePost(dir.newOrder, {
    identifiers: domains.map((d) => ({ type: "dns", value: d })),
  });

  if (orderResult.status !== 201) {
    throw new Error(
      `LE newOrder failed (${orderResult.status}): ${JSON.stringify(orderResult.body)}`,
    );
  }

  const leOrderUrl = orderResult.headers.get("location") || "";
  const leOrder = orderResult.body;

  // 2. Handle authorizations
  for (const authzUrl of leOrder.authorizations || []) {
    const authzResult = await lePost(authzUrl, null); // POST-as-GET
    const authz = authzResult.body;

    if (authz.status === "valid") continue;

    const challenge = authz.challenges?.find(
      (c: any) => c.type === "dns-01",
    );
    if (!challenge) throw new Error("No dns-01 challenge from LE");

    // Compute DNS TXT value: base64url(sha256(token.thumbprint))
    const accountJwk = await jose.exportJWK(leAccountKey!);
    const pubJwk: Record<string, unknown> = { ...accountJwk };
    delete pubJwk.d; // Public key only for thumbprint
    const thumbprint = await jose.calculateJwkThumbprint(
      pubJwk as jose.JWK,
    );
    const keyAuth = `${challenge.token}.${thumbprint}`;
    const txtValue = createHash("sha256")
      .update(keyAuth)
      .digest("base64url");

    const domain = authz.identifier.value;
    const txtName = `_acme-challenge.${domain}`;

    // Create TXT record in pdns
    await pdnsPatchTxt(txtName, txtValue);

    // Respond to challenge (tell LE to validate)
    await lePost(challenge.url, {});

    // Poll authorization until valid
    const finalAuthz = await pollLeResource(authzUrl, 120_000);
    await pdnsDeleteTxt(txtName);

    if (finalAuthz.status !== "valid") {
      throw new Error(`LE authz failed: ${JSON.stringify(finalAuthz)}`);
    }
  }

  // 3. Finalize with instance's CSR
  const finalizeResult = await lePost(leOrder.finalize, {
    csr: csrDer.toString("base64url"),
  });

  if (finalizeResult.status !== 200) {
    throw new Error(
      `LE finalize failed (${finalizeResult.status}): ${JSON.stringify(finalizeResult.body)}`,
    );
  }

  // 4. Poll order until valid
  const completed = await pollLeResource(leOrderUrl, 120_000);
  if (completed.status !== "valid" || !completed.certificate) {
    throw new Error(`LE order not valid: ${JSON.stringify(completed)}`);
  }

  // 5. Download cert chain (returns PEM text, not JSON)
  const certResult = await lePost(completed.certificate, null);
  if (typeof certResult.body !== "string") {
    throw new Error(
      `LE cert download returned unexpected type: ${typeof certResult.body}`,
    );
  }

  return certResult.body;
}

/**
 * Poll a LE resource (order or authz) until it reaches "valid" or "invalid".
 */
async function pollLeResource(
  url: string,
  timeout: number,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await lePost(url, null); // POST-as-GET
    const status = result.body?.status;
    if (status === "valid" || status === "invalid") return result.body;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timeout polling ${url}`);
}

// --- pdns TXT record helpers (for LE DNS-01 challenges) ---

async function pdnsPatchTxt(name: string, value: string): Promise<void> {
  const fqdn = name.endsWith(".") ? name : `${name}.`;
  const url = `${config!.pdnsApiUrl}/api/v1/servers/localhost/zones/${config!.pdnsZone}`;

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      "X-API-Key": config!.pdnsApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rrsets: [
        {
          name: fqdn,
          type: "TXT",
          ttl: 60,
          changetype: "REPLACE",
          records: [{ content: `"${value}"`, disabled: false }],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`pdns TXT REPLACE failed (${resp.status}): ${body}`);
  }

  log("acme", `TXT ${fqdn} = ${value}`);
}

async function pdnsDeleteTxt(name: string): Promise<void> {
  const fqdn = name.endsWith(".") ? name : `${name}.`;
  const url = `${config!.pdnsApiUrl}/api/v1/servers/localhost/zones/${config!.pdnsZone}`;

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      "X-API-Key": config!.pdnsApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rrsets: [
        {
          name: fqdn,
          type: "TXT",
          ttl: 60,
          changetype: "DELETE",
          records: [],
        },
      ],
    }),
  });

  if (!resp.ok) {
    log("acme", `TXT DELETE ${fqdn} failed (${resp.status})`);
  }
}

// --- HTTP helpers ---

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
    ...headers,
  });
  res.end(json);
}

function sendAcmeError(
  res: import("node:http").ServerResponse,
  status: number,
  type: string,
  detail: string,
  nonce: string,
): void {
  sendJson(
    res,
    status,
    {
      type: `urn:ietf:params:acme:error:${type}`,
      detail,
    },
    { "Replay-Nonce": nonce },
  );
}

async function readBody(
  req: import("node:http").IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
