// Tests for shared/identity.ts — IPNS CID derivation, round-trip, validation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ipnsCidFromSshPubkey,
  ipnsCidFromEd25519,
  publicKeyFromIpnsCid,
  isValidIpnsCid,
  parseEd25519SshPubkey,
} from "../shared/identity.js";

// Test vector: a known Ed25519 SSH public key
// Generated via: ssh-keygen -t ed25519 -f /dev/stdin -N "" -C "test" < /dev/null
// The raw 32-byte key is deterministic from the key material.
const TEST_SSH_PUBKEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHqBMzJB3voP6acB2DdfTb+n3vL8yCvD2A1u+9v6rUHQ test";

describe("parseEd25519SshPubkey", () => {
  it("extracts 32 bytes from a valid ssh-ed25519 key", () => {
    const key = parseEd25519SshPubkey(TEST_SSH_PUBKEY);
    assert.equal(key.length, 32);
  });

  it("rejects non-ed25519 key types", () => {
    assert.throws(
      () => parseEd25519SshPubkey("ssh-rsa AAAAB3... test"),
      /not an ssh-ed25519/,
    );
  });

  it("handles keys with comments", () => {
    const key = parseEd25519SshPubkey(TEST_SSH_PUBKEY + " extra comment");
    assert.equal(key.length, 32);
  });

  it("handles keys without comments", () => {
    const parts = TEST_SSH_PUBKEY.split(" ");
    const noComment = `${parts[0]} ${parts[1]}`;
    const key = parseEd25519SshPubkey(noComment);
    assert.equal(key.length, 32);
  });
});

describe("ipnsCidFromSshPubkey", () => {
  it("produces a base36 CID starting with 'k'", () => {
    const cid = ipnsCidFromSshPubkey(TEST_SSH_PUBKEY);
    assert.ok(cid.startsWith("k"), `expected CID to start with 'k', got: ${cid}`);
  });

  it("produces deterministic output", () => {
    const a = ipnsCidFromSshPubkey(TEST_SSH_PUBKEY);
    const b = ipnsCidFromSshPubkey(TEST_SSH_PUBKEY);
    assert.equal(a, b);
  });

  it("produces different CIDs for different keys", () => {
    // Different key (first byte of the raw key changed)
    const key1 = parseEd25519SshPubkey(TEST_SSH_PUBKEY);
    const key2 = new Uint8Array(key1);
    key2[0] ^= 0xff;
    const cid1 = ipnsCidFromEd25519(key1);
    const cid2 = ipnsCidFromEd25519(key2);
    assert.notEqual(cid1, cid2);
  });
});

describe("publicKeyFromIpnsCid (round-trip)", () => {
  it("recovers the original Ed25519 key from a CID", () => {
    const originalKey = parseEd25519SshPubkey(TEST_SSH_PUBKEY);
    const cid = ipnsCidFromEd25519(originalKey);
    const recoveredKey = publicKeyFromIpnsCid(cid);
    assert.deepEqual(recoveredKey, originalKey);
  });

  it("rejects non-base36 CIDs", () => {
    assert.throws(
      () => publicKeyFromIpnsCid("zQmYtUc4YQ8v6p6tZT"),
      /must start with 'k'/,
    );
  });

  it("round-trips through SSH pubkey → CID → key → CID", () => {
    const cid1 = ipnsCidFromSshPubkey(TEST_SSH_PUBKEY);
    const key = publicKeyFromIpnsCid(cid1);
    const cid2 = ipnsCidFromEd25519(key);
    assert.equal(cid1, cid2);
  });
});

describe("isValidIpnsCid", () => {
  it("accepts a valid IPNS CID", () => {
    const cid = ipnsCidFromSshPubkey(TEST_SSH_PUBKEY);
    assert.ok(isValidIpnsCid(cid));
  });

  it("rejects garbage strings", () => {
    assert.ok(!isValidIpnsCid("not-a-cid"));
    assert.ok(!isValidIpnsCid(""));
    assert.ok(!isValidIpnsCid("k"));
    assert.ok(!isValidIpnsCid("k0"));
  });

  it("rejects non-base36 prefixes", () => {
    assert.ok(!isValidIpnsCid("bafybei..."));
    assert.ok(!isValidIpnsCid("Qm..."));
  });
});

describe("CID format", () => {
  it("produces CIDs that start with k51qzi5 (Ed25519 identity multihash pattern)", () => {
    // All Ed25519 identity CIDs should share the same prefix because:
    // CIDv1(1) + libp2p-key(0x72) + identity(0x00) + length(36) + protobuf-header
    // encodes to the same base36 prefix
    const cid = ipnsCidFromSshPubkey(TEST_SSH_PUBKEY);
    assert.ok(
      cid.startsWith("k51qzi5uqu5d"),
      `expected k51qzi5uqu5d prefix, got: ${cid.slice(0, 20)}`,
    );
  });

  it("CID length is consistent for Ed25519 keys", () => {
    // All Ed25519 keys produce the same size CID (32-byte key → fixed protobuf → fixed CID)
    const cid = ipnsCidFromSshPubkey(TEST_SSH_PUBKEY);
    // CID binary: 1 + 1 + 1 + 1 + 36 = 40 bytes, base36-encoded ≈ 62 chars + 'k' prefix
    assert.ok(cid.length > 50, `CID too short: ${cid.length}`);
    assert.ok(cid.length < 70, `CID too long: ${cid.length}`);
  });
});
