// Shim-owned swtpm: pure helpers for the controller.
//
// On the shim path the Kata shim (not the host agent) runs swtpm for an
// instance. The controller tells it what to do via pod annotations:
//   seed.loom.farm/tpm-mode        create | verify
//   seed.loom.farm/tpm-state-dir   /var/lib/seed-controller/tpm/<ns>-<instance>
//   seed.loom.farm/tpm-fingerprint lowercase hex SHA-256 (verify only)
// After a successful create-mode boot the shim writes the fingerprint to
// <state-dir>/tpm-fingerprint; the controller records it in the instance's
// SeedTPM and re-renders the pod in verify mode.

import type { ShimTpmMode } from "./types.js";

export const TPM_STATE_BASE = "/var/lib/seed-controller/tpm";
export const FINGERPRINT_FILE = "tpm-fingerprint";

/** Host path of an instance's TPM state directory (CephFS). */
export function tpmStateDir(namespace: string, instance: string): string {
  return `${TPM_STATE_BASE}/${namespace}-${instance}`;
}

/** Inputs for rendering instance TPMs in one namespace. */
export interface ShimTpmRenderContext {
  /** Recorded SeedTPM fingerprints by instance name. */
  records: Map<string, string>;
}

// --- Fingerprints ---

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export function isValidFingerprint(s: unknown): s is string {
  return typeof s === "string" && FINGERPRINT_RE.test(s);
}

export type FingerprintParse =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: string };

/**
 * Validate the contents of <state-dir>/tpm-fingerprint: exactly 64 lowercase
 * hex chars, optionally followed by a single newline. Anything else (upper
 * case, whitespace, extra lines) is rejected rather than normalized — the
 * shim is the only writer and must write the canonical form.
 */
export function parseFingerprintFile(content: string): FingerprintParse {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (body.length === 0) return { ok: false, reason: "empty fingerprint file" };
  if (!FINGERPRINT_RE.test(body)) {
    const preview = JSON.stringify(body.slice(0, 80));
    return { ok: false, reason: `malformed fingerprint (want 64 lowercase hex chars): ${preview}` };
  }
  return { ok: true, fingerprint: body };
}

/** Render mode for an opted-in instance given its recorded fingerprint. */
export function shimTpmModeFor(recorded: string | null | undefined): ShimTpmMode {
  return isValidFingerprint(recorded)
    ? { mode: "verify", fingerprint: recorded }
    : { mode: "create" };
}

// --- Create → verify flip ---

/** Tolerated clock skew between the node that wrote the file and the pod's startTime. */
export const FINGERPRINT_MTIME_SLACK_MS = 5 * 60_000;

export interface TpmFlipInput {
  /** SeedTPM status.fingerprint, if recorded. */
  recorded: string | null;
  /** tpm-mode annotation of the instance's current pod (null: no pod / legacy pod). */
  podMode: "create" | "verify" | null;
  /** Pod Ready and not terminating. */
  podReady: boolean;
  /** Pod status.startTime in ms, if known. */
  podStartedAtMs: number | null;
  /** <state-dir>/tpm-fingerprint, or null if it doesn't exist. */
  file: { content: string; mtimeMs: number } | null;
}

export type TpmFlipDecision =
  /** Nothing to do. */
  | { action: "none" }
  /** Not yet — check again later. */
  | { action: "wait"; reason: string }
  /** Record this fingerprint in SeedTPM, then re-render in verify mode. */
  | { action: "record"; fingerprint: string; createdAtMs: number }
  /** Already recorded but the pod still runs in create mode: re-render in verify mode. */
  | { action: "apply-verify"; fingerprint: string }
  /** File disagrees with the record. Never auto-resolved. */
  | { action: "mismatch"; recorded: string; file: string }
  /** File exists but can't be trusted. */
  | { action: "invalid-file"; reason: string };

/**
 * Decide what to do for one opted-in instance. Pure, so it can be unit
 * tested; the controller feeds it cluster + filesystem state on every pod
 * event and periodic sweep, so every outcome must be idempotent.
 *
 * Invariants:
 *   - a recorded fingerprint is never replaced (mismatch is reported only);
 *   - a fingerprint is only recorded from a Ready create-mode pod, and only
 *     if the file was written after that pod started (not a leftover).
 */
export function decideTpmFlip(input: TpmFlipInput): TpmFlipDecision {
  const parsed = input.file ? parseFingerprintFile(input.file.content) : null;

  if (input.recorded) {
    if (parsed?.ok && parsed.fingerprint !== input.recorded) {
      return { action: "mismatch", recorded: input.recorded, file: parsed.fingerprint };
    }
    if (input.podMode === "create") {
      return { action: "apply-verify", fingerprint: input.recorded };
    }
    return { action: "none" };
  }

  // No record yet: only a create-mode pod can produce one.
  if (input.podMode !== "create") return { action: "none" };
  if (!input.podReady) return { action: "wait", reason: "create-mode pod not Ready" };
  if (!input.file || !parsed) return { action: "wait", reason: `${FINGERPRINT_FILE} not written yet` };
  if (!parsed.ok) return { action: "invalid-file", reason: parsed.reason };
  if (
    input.podStartedAtMs !== null &&
    input.file.mtimeMs < input.podStartedAtMs - FINGERPRINT_MTIME_SLACK_MS
  ) {
    return {
      action: "invalid-file",
      reason: `${FINGERPRINT_FILE} (mtime ${new Date(input.file.mtimeMs).toISOString()}) predates the ` +
        `create-mode pod (started ${new Date(input.podStartedAtMs).toISOString()}); refusing a stale file`,
    };
  }
  return { action: "record", fingerprint: parsed.fingerprint, createdAtMs: input.file.mtimeMs };
}
