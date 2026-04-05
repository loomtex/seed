// Browser identity via WebAuthn PRF + Ed25519.
//
// No private key material stored in the browser. The FIDO token derives
// a deterministic Ed25519 keypair at signing time via the PRF extension.
// IndexedDB holds only the WebAuthn credential ID (public, non-sensitive).
//
// Flow:
//   1. Register: WebAuthn create() with prf extension → store credential ID
//   2. Sign: WebAuthn get() with PRF salt → 32-byte seed → Ed25519 keypair
//   3. Build SiloKey header → discard key material
import { ed25519 } from "@noble/curves/ed25519";

const DB_NAME = "silo";
const DB_STORE = "identity";
const DB_KEY = "credential";
const PRF_SALT = new TextEncoder().encode("silo-ed25519-v1");

// --- IndexedDB helpers (credential ID only, no secrets) ---

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadCredential() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(DB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function saveCredential(cred) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(cred, DB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearCredential() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(DB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- WebAuthn registration ---

export async function register() {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "silo", id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "silo-user",
        displayName: "Silo User",
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },   // ES256
        { alg: -8, type: "public-key" },   // EdDSA
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "discouraged",
      },
      extensions: { prf: {} },
    },
  });

  const prfEnabled = credential.getClientExtensionResults()?.prf?.enabled;
  if (!prfEnabled) {
    throw new Error("Authenticator does not support the PRF extension");
  }

  // Store only the credential ID (non-sensitive)
  await saveCredential({
    id: Array.from(new Uint8Array(credential.rawId)),
    rpId: location.hostname,
  });

  // Derive the public key so we can show it immediately
  return deriveKeypair(credential.rawId);
}

// --- Ed25519 derivation from PRF ---

async function getPrfSeed(credentialId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{
        id: credentialId,
        type: "public-key",
      }],
      userVerification: "discouraged",
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      },
    },
  });

  const prfResult = assertion.getClientExtensionResults()?.prf?.results?.first;
  if (!prfResult) {
    throw new Error("PRF evaluation failed — touch your key and try again");
  }

  return new Uint8Array(prfResult);
}

async function deriveKeypair(credentialId) {
  const seed = await getPrfSeed(credentialId);
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey };
}

// --- SSH wire format encoding ---

function sshWirePublicKey(ed25519Pub) {
  // SSH wire format: uint32 len + "ssh-ed25519" + uint32 len + 32-byte key
  const keyType = new TextEncoder().encode("ssh-ed25519");
  const buf = new Uint8Array(4 + keyType.length + 4 + ed25519Pub.length);
  const view = new DataView(buf.buffer);
  let offset = 0;

  view.setUint32(offset, keyType.length);
  offset += 4;
  buf.set(keyType, offset);
  offset += keyType.length;

  view.setUint32(offset, ed25519Pub.length);
  offset += 4;
  buf.set(ed25519Pub, offset);

  return buf;
}

function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// --- Public key in authorized_keys format ---

export function authorizedKeysLine(publicKey) {
  const wireKey = sshWirePublicKey(publicKey);
  return `ssh-ed25519 ${toBase64(wireKey)}`;
}

// --- SiloKey header for authenticated git push ---

export async function sign() {
  const cred = await loadCredential();
  if (!cred) throw new Error("No registered identity — register a key first");

  const credentialId = new Uint8Array(cred.id);
  const { seed, publicKey } = await deriveKeypair(credentialId);

  const ts = Math.floor(Date.now() / 1000).toString();
  const message = new TextEncoder().encode(`silo-auth:${ts}`);
  const signature = ed25519.sign(message, seed);

  // Encode in the format the auth verifier expects
  const wireKey = sshWirePublicKey(publicKey);
  const header = `SiloKey ${toBase64(wireKey)} ${toBase64(signature)} ${ts}`;

  // Wipe seed from memory (best effort — JS has no secure zeroing)
  seed.fill(0);

  return header;
}

// --- Identity status ---

export async function getIdentity() {
  const cred = await loadCredential();
  if (!cred) return null;

  try {
    const { publicKey } = await deriveKeypair(new Uint8Array(cred.id));
    return { publicKey, authorizedKeys: authorizedKeysLine(publicKey) };
  } catch {
    // Token not present — return credential exists but can't derive
    return { registered: true, publicKey: null };
  }
}

export async function hasCredential() {
  const cred = await loadCredential();
  return cred !== null;
}
