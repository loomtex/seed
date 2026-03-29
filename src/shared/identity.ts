// IPNS CID derivation and SSH signature verification for seed identity.
//
// Each seed repo commits a .seed-identity file containing an IPNS CID
// derived from an Ed25519 keypair. The CID uses identity multihash
// (IPNS spec §4.1.6) so the public key is inlined — no hashing, fully
// reversible. This means spec.publicKey is redundant.
//
// Derivation: SSH pubkey → 32-byte Ed25519 → libp2p protobuf → identity
// multihash → CIDv1(libp2p-key) → base36 → "k51qzi5..."

import { createHash, createPublicKey, verify } from "node:crypto";

// --- Base36 encoding/decoding (multibase base36lower, prefix 'k') ---

const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Encode a Uint8Array as base36 (no prefix). */
function base36Encode(data: Uint8Array): string {
  // BigInt-based conversion
  let n = 0n;
  for (const byte of data) {
    n = (n << 8n) | BigInt(byte);
  }
  if (n === 0n) return "0";
  let result = "";
  while (n > 0n) {
    result = BASE36_ALPHABET[Number(n % 36n)] + result;
    n = n / 36n;
  }
  // Preserve leading zeros
  for (const byte of data) {
    if (byte !== 0) break;
    result = "0" + result;
  }
  return result;
}

/** Decode a base36 string (no prefix) to Uint8Array. */
function base36Decode(str: string): Uint8Array {
  let n = 0n;
  for (const ch of str) {
    const idx = BASE36_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base36 character: ${ch}`);
    n = n * 36n + BigInt(idx);
  }
  // Convert BigInt to bytes
  const hex = n.toString(16);
  const paddedHex = hex.length % 2 ? "0" + hex : hex;
  const bytes: number[] = [];
  for (let i = 0; i < paddedHex.length; i += 2) {
    bytes.push(parseInt(paddedHex.slice(i, i + 2), 16));
  }
  // Restore leading zero bytes
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch !== "0") break;
    leadingZeros++;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

// --- Unsigned varint encoding/decoding ---

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

function decodeVarint(data: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    value |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [value, pos];
}

// --- SSH public key parsing ---

/** Extract the raw 32-byte Ed25519 public key from an SSH public key string.
 *  Accepts "ssh-ed25519 AAAA..." format (with or without comment). */
export function parseEd25519SshPubkey(sshPubkey: string): Uint8Array {
  const parts = sshPubkey.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519") {
    throw new Error("not an ssh-ed25519 public key");
  }
  const decoded = Buffer.from(parts[1], "base64");
  // SSH wire format: uint32 length + "ssh-ed25519" + uint32 length + 32-byte key
  let offset = 0;
  const typeLen = decoded.readUInt32BE(offset); offset += 4;
  const typeStr = decoded.subarray(offset, offset + typeLen).toString("ascii"); offset += typeLen;
  if (typeStr !== "ssh-ed25519") {
    throw new Error(`unexpected key type in blob: ${typeStr}`);
  }
  const keyLen = decoded.readUInt32BE(offset); offset += 4;
  if (keyLen !== 32) {
    throw new Error(`unexpected Ed25519 key length: ${keyLen}`);
  }
  return new Uint8Array(decoded.subarray(offset, offset + 32));
}

// --- libp2p protobuf encoding ---

/** Wrap a raw Ed25519 public key in a libp2p PublicKey protobuf.
 *  message PublicKey { KeyType Type = 1; bytes Data = 2; }
 *  Ed25519 = 1 */
function wrapLibp2pPubkey(ed25519Key: Uint8Array): Uint8Array {
  // Field 1 (Type): wire type 0 (varint), field 1 → tag 0x08, value 1
  // Field 2 (Data): wire type 2 (length-delimited), field 2 → tag 0x12, length 32
  const buf = new Uint8Array(2 + 2 + ed25519Key.length);
  buf[0] = 0x08; // field 1, varint
  buf[1] = 0x01; // Ed25519 = 1
  buf[2] = 0x12; // field 2, length-delimited
  buf[3] = ed25519Key.length; // 32
  buf.set(ed25519Key, 4);
  return buf;
}

/** Extract Ed25519 public key from a libp2p PublicKey protobuf. */
function unwrapLibp2pPubkey(protobuf: Uint8Array): Uint8Array {
  // Parse field 1: tag 0x08, value should be 1 (Ed25519)
  if (protobuf[0] !== 0x08 || protobuf[1] !== 0x01) {
    throw new Error("not an Ed25519 libp2p public key");
  }
  // Parse field 2: tag 0x12, length, data
  if (protobuf[2] !== 0x12) {
    throw new Error("missing data field in libp2p public key");
  }
  const len = protobuf[3];
  if (len !== 32) {
    throw new Error(`unexpected Ed25519 key length in protobuf: ${len}`);
  }
  return protobuf.subarray(4, 4 + 32);
}

// --- IPNS CID construction ---

/**
 * Derive an IPNS CID from an SSH Ed25519 public key string.
 * Returns a base36-encoded CIDv1 with identity multihash (starts with "k51qzi5...").
 *
 * Steps:
 *   1. Parse 32-byte Ed25519 key from SSH format
 *   2. Wrap in libp2p protobuf (~36 bytes)
 *   3. Identity multihash: 0x00 <varint-length> <protobuf>
 *   4. CIDv1: version=1, codec=libp2p-key(0x72), multihash
 *   5. Base36-encode with 'k' multibase prefix
 */
export function ipnsCidFromSshPubkey(sshPubkey: string): string {
  const ed25519Key = parseEd25519SshPubkey(sshPubkey);
  return ipnsCidFromEd25519(ed25519Key);
}

/** Derive IPNS CID from raw 32-byte Ed25519 public key. */
export function ipnsCidFromEd25519(ed25519Key: Uint8Array): string {
  if (ed25519Key.length !== 32) {
    throw new Error(`Ed25519 key must be 32 bytes, got ${ed25519Key.length}`);
  }

  const protobuf = wrapLibp2pPubkey(ed25519Key);

  // Identity multihash: code=0x00 (identity), length=protobuf.length, data=protobuf
  const lengthVarint = encodeVarint(protobuf.length);
  const multihash = new Uint8Array(1 + lengthVarint.length + protobuf.length);
  multihash[0] = 0x00; // identity hash function code
  multihash.set(lengthVarint, 1);
  multihash.set(protobuf, 1 + lengthVarint.length);

  // CIDv1: version=1, codec=0x72 (libp2p-key), multihash
  const versionVarint = encodeVarint(1);
  const codecVarint = encodeVarint(0x72);
  const cid = new Uint8Array(versionVarint.length + codecVarint.length + multihash.length);
  cid.set(versionVarint, 0);
  cid.set(codecVarint, versionVarint.length);
  cid.set(multihash, versionVarint.length + codecVarint.length);

  // Base36 with 'k' multibase prefix
  return "k" + base36Encode(cid);
}

/**
 * Extract the raw 32-byte Ed25519 public key from an IPNS CID.
 * Reverses the CID construction: base36 → CIDv1 → identity multihash → protobuf → key.
 */
export function publicKeyFromIpnsCid(cid: string): Uint8Array {
  if (!cid.startsWith("k")) {
    throw new Error("IPNS CID must start with 'k' (base36 multibase prefix)");
  }

  const bytes = base36Decode(cid.slice(1));

  // Parse CIDv1: version, codec, multihash
  let offset: number;
  let version: number;
  [version, offset] = decodeVarint(bytes, 0);
  if (version !== 1) {
    throw new Error(`expected CIDv1, got version ${version}`);
  }

  let codec: number;
  [codec, offset] = decodeVarint(bytes, offset);
  if (codec !== 0x72) {
    throw new Error(`expected libp2p-key codec (0x72), got 0x${codec.toString(16)}`);
  }

  // Parse identity multihash: code=0x00, length, data
  let hashCode: number;
  [hashCode, offset] = decodeVarint(bytes, offset);
  if (hashCode !== 0x00) {
    throw new Error(`expected identity multihash (0x00), got 0x${hashCode.toString(16)}`);
  }

  let dataLen: number;
  [dataLen, offset] = decodeVarint(bytes, offset);

  const protobuf = bytes.subarray(offset, offset + dataLen);
  return unwrapLibp2pPubkey(protobuf);
}

/**
 * Validate that a string looks like a valid IPNS CID.
 * Must start with 'k' (base36), decode to CIDv1 with libp2p-key codec
 * and identity multihash containing an Ed25519 key.
 */
export function isValidIpnsCid(cid: string): boolean {
  try {
    const key = publicKeyFromIpnsCid(cid);
    return key.length === 32;
  } catch {
    return false;
  }
}

// --- SSH signature verification ---

/**
 * Verify an SSH signature (produced by `ssh-keygen -Y sign`) against a message.
 *
 * SSH signature format (RFC draft):
 *   -----BEGIN SSH SIGNATURE-----
 *   <base64 binary>
 *   -----END SSH SIGNATURE-----
 *
 * Binary format:
 *   "SSHSIG" magic (6 bytes)
 *   uint32 + version (always 0x01)
 *   string publickey (SSH wire format)
 *   string namespace
 *   string reserved (empty)
 *   string hash_algorithm
 *   string H(message) — the hash
 *
 * For Ed25519, the signature is in the publickey-specific blob.
 */
export function verifyPlantSignature(
  message: string,
  signatureArmored: string,
  ipnsCid: string,
): boolean {
  try {
    // Extract Ed25519 public key from IPNS CID
    const expectedPubkey = publicKeyFromIpnsCid(ipnsCid);

    // Parse the armored SSH signature
    const lines = signatureArmored.trim().split("\n");
    const b64Lines: string[] = [];
    let inBody = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "-----BEGIN SSH SIGNATURE-----") { inBody = true; continue; }
      if (trimmed === "-----END SSH SIGNATURE-----") { inBody = false; continue; }
      if (inBody) b64Lines.push(trimmed);
    }
    const sigBuf = Buffer.from(b64Lines.join(""), "base64");

    // Parse SSH signature binary format
    let offset = 0;

    // Magic: "SSHSIG" (6 bytes)
    const magic = sigBuf.subarray(offset, offset + 6).toString("ascii");
    offset += 6;
    if (magic !== "SSHSIG") throw new Error(`bad magic: ${magic}`);

    // Version: uint32
    const ver = sigBuf.readUInt32BE(offset); offset += 4;
    if (ver !== 1) throw new Error(`unsupported version: ${ver}`);

    // Public key blob: string (uint32 len + data)
    const pubkeyLen = sigBuf.readUInt32BE(offset); offset += 4;
    const pubkeyBlob = sigBuf.subarray(offset, offset + pubkeyLen); offset += pubkeyLen;

    // Extract Ed25519 key from the SSH pubkey blob
    let pkOff = 0;
    const pkTypeLen = pubkeyBlob.readUInt32BE(pkOff); pkOff += 4;
    pkOff += pkTypeLen; // skip type string
    const pkKeyLen = pubkeyBlob.readUInt32BE(pkOff); pkOff += 4;
    const embeddedPubkey = pubkeyBlob.subarray(pkOff, pkOff + pkKeyLen);

    // Verify the embedded public key matches the one from the IPNS CID
    if (embeddedPubkey.length !== expectedPubkey.length) return false;
    for (let i = 0; i < expectedPubkey.length; i++) {
      if (embeddedPubkey[i] !== expectedPubkey[i]) return false;
    }

    // Namespace: string
    const nsLen = sigBuf.readUInt32BE(offset); offset += 4;
    const ns = sigBuf.subarray(offset, offset + nsLen).toString("ascii"); offset += nsLen;

    // Reserved: string (should be empty)
    const reservedLen = sigBuf.readUInt32BE(offset); offset += 4;
    offset += reservedLen;

    // Hash algorithm: string
    const hashAlgLen = sigBuf.readUInt32BE(offset); offset += 4;
    const hashAlg = sigBuf.subarray(offset, offset + hashAlgLen).toString("ascii"); offset += hashAlgLen;

    // Signature blob: string (contains the actual Ed25519 signature)
    const sigBlobLen = sigBuf.readUInt32BE(offset); offset += 4;
    const sigBlob = sigBuf.subarray(offset, offset + sigBlobLen);

    // Parse the signature blob: string sig_type + string signature
    let sbOff = 0;
    const sigTypeLen = sigBlob.readUInt32BE(sbOff); sbOff += 4;
    const sigType = sigBlob.subarray(sbOff, sbOff + sigTypeLen).toString("ascii"); sbOff += sigTypeLen;
    if (sigType !== "ssh-ed25519") throw new Error(`unexpected signature type: ${sigType}`);

    const rawSigLen = sigBlob.readUInt32BE(sbOff); sbOff += 4;
    const rawSig = sigBlob.subarray(sbOff, sbOff + rawSigLen);

    // Build the signed data structure (what ssh-keygen actually signs):
    // "SSHSIG" magic + uint32 namespace_len + namespace + uint32 0 (reserved) +
    // uint32 hash_alg_len + hash_alg + uint32 hash_len + H(message)
    const msgHash = createHash(hashAlg === "sha512" ? "sha512" : "sha256")
      .update(message)
      .digest();

    const nsBuf = Buffer.from(ns, "ascii");
    const hashAlgBuf = Buffer.from(hashAlg, "ascii");

    const signedData = Buffer.alloc(
      6 + // SSHSIG
      4 + nsBuf.length +
      4 + // reserved (empty)
      4 + hashAlgBuf.length +
      4 + msgHash.length
    );
    let sdOff = 0;
    signedData.write("SSHSIG", sdOff, "ascii"); sdOff += 6;
    signedData.writeUInt32BE(nsBuf.length, sdOff); sdOff += 4;
    nsBuf.copy(signedData, sdOff); sdOff += nsBuf.length;
    signedData.writeUInt32BE(0, sdOff); sdOff += 4; // reserved
    signedData.writeUInt32BE(hashAlgBuf.length, sdOff); sdOff += 4;
    hashAlgBuf.copy(signedData, sdOff); sdOff += hashAlgBuf.length;
    signedData.writeUInt32BE(msgHash.length, sdOff); sdOff += 4;
    msgHash.copy(signedData, sdOff);

    // Verify with Ed25519
    const publicKeyObj = createPublicKey({
      key: Buffer.concat([
        // Ed25519 public key in PKCS#8/SubjectPublicKeyInfo DER format
        // OID 1.3.101.112 = Ed25519
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(expectedPubkey),
      ]),
      format: "der",
      type: "spki",
    });

    return verify(null, signedData, publicKeyObj, rawSig);
  } catch {
    return false;
  }
}

/**
 * Extract .seed-identity content from a flake source directory.
 * Returns the IPNS CID string, or null if not found.
 */
export async function readSeedIdentity(storePath: string): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(`${storePath}/.seed-identity`, "utf-8");
    const cid = content.trim();
    if (!isValidIpnsCid(cid)) return null;
    return cid;
  } catch {
    return null;
  }
}
