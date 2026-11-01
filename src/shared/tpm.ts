// Shim-owned swtpm: pure helpers shared by the controller and host agent.
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
/** Provisioning writes the Ceph fsid here; proves TPM_STATE_BASE is the real CephFS mount. */
export const SENTINEL_FILE = ".seed-fs";
/** The only part of a state dir a shim-path guest sees (at /seed/tpm): its age identity. */
export const GUEST_SUBDIR = "guest";

/** Host path of an instance's TPM state directory (CephFS). */
export function tpmStateDir(namespace: string, instance: string): string {
  return `${TPM_STATE_BASE}/${namespace}-${instance}`;
}

/**
 * Host path of the subdirectory mounted into a shim-path guest at /seed/tpm.
 * The guest must never see the state dir itself: tpm2-00.permall is the TPM's
 * unencrypted persistent state (seeds and keys), and tpm-fingerprint is what
 * the controller trusts when it records the TPM's identity.
 */
export function tpmGuestDir(namespace: string, instance: string): string {
  return `${tpmStateDir(namespace, instance)}/${GUEST_SUBDIR}`;
}

// --- Opt-in (SEED_SHIM_SWTPM) ---

export interface ShimSwtpmOptIn {
  /** True if this instance's swtpm is owned by the shim. */
  matches(namespace: string, instance: string): boolean;
  /** Entries that didn't parse (reported once at startup). */
  invalid: string[];
}

/**
 * Parse SEED_SHIM_SWTPM: comma-separated `<namespace>/<instance>`,
 * `<namespace>/*`, or `*`. Empty/unset opts nobody in.
 */
export function parseShimSwtpmOptIn(raw: string | undefined): ShimSwtpmOptIn {
  let all = false;
  const namespaces = new Set<string>();
  const instances = new Set<string>();
  const invalid: string[] = [];
  const nameRe = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (entry === "*") {
      all = true;
      continue;
    }
    const parts = entry.split("/");
    if (parts.length !== 2 || !nameRe.test(parts[0])) {
      invalid.push(entry);
      continue;
    }
    const [ns, inst] = parts;
    if (inst === "*") namespaces.add(ns);
    else if (nameRe.test(inst)) instances.add(`${ns}/${inst}`);
    else invalid.push(entry);
  }

  return {
    matches: (ns, inst) => all || namespaces.has(ns) || instances.has(`${ns}/${inst}`),
    invalid,
  };
}

/** Inputs for rendering shim-owned swtpm instances in one namespace. */
export interface ShimTpmRenderContext {
  /** Effective opt-in (see effectiveShimOptIn). */
  optIn: ShimSwtpmOptIn;
  /** Recorded SeedTPM fingerprints by instance name. */
  records: Map<string, string>;
}

/**
 * Narrow the configured opt-in for one namespace: an opted-in instance with
 * no recorded fingerprint but an existing TPM state (permall) is held back on
 * the legacy path. Rendering it in create mode would ask the shim to create a
 * TPM over a live one; it needs `tpm-backfill` first. Returns the effective
 * opt-in plus the held-back instance names (for logging).
 */
export function effectiveShimOptIn(
  optIn: ShimSwtpmOptIn,
  namespace: string,
  records: Map<string, string>,
  unrecordedWithState: Set<string>,
): { optIn: ShimSwtpmOptIn; heldBack: string[] } {
  const heldBack = [...unrecordedWithState].filter(
    (name) => optIn.matches(namespace, name) && !records.has(name)).sort();
  const blocked = new Set(heldBack);
  return {
    optIn: {
      matches: (ns, inst) => optIn.matches(ns, inst) && !(ns === namespace && blocked.has(inst)),
      invalid: optIn.invalid,
    },
    heldBack,
  };
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
