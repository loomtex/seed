// Upgrade schedule — pure functions, mirrors infra/profiles/seed-upgrade.nix.
//
// Order = control-plane nodes sorted by name, then other nodes sorted by
// name; bucket = index mod BUCKETS; local time = 04:00 + 30 min × bucket,
// plus a fixed 0–10 min per-node jitter derived from the node name. Every
// agent computes this from the Node list, so the DaemonSet spec is identical
// on every node. The Lease is what actually serializes upgrades; buckets
// just keep them spread out.

import { createHash } from "node:crypto";

export const UPGRADE_BUCKETS = 4;
export const BUCKET_MINUTES = 30;
export const FIRST_UPGRADE_MINUTES = 4 * 60;
export const JITTER_SECONDS = 600;

export const CONTROL_PLANE_LABEL = "node-role.kubernetes.io/control-plane";

export interface ScheduleNode {
  name: string;
  controlPlane: boolean;
}

/** Byte-wise string order (same as Nix's lib.lessThan), not locale order. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Upgrade order: control-plane nodes first, each group sorted by name. */
export function upgradeOrder(nodes: ScheduleNode[]): string[] {
  const servers = nodes.filter((n) => n.controlPlane).map((n) => n.name).sort(byName);
  const others = nodes.filter((n) => !n.controlPlane).map((n) => n.name).sort(byName);
  return [...servers, ...others];
}

/** Fixed per-node jitter in [0, JITTER_SECONDS), from sha256(name). */
export function nodeJitterSeconds(name: string): number {
  const digest = createHash("sha256").update(name).digest();
  return digest.readUInt32BE(0) % JITTER_SECONDS;
}

export interface NodeSchedule {
  index: number;
  bucket: number;
  /** Seconds after local midnight (bucket time + jitter). */
  secondsOfDay: number;
}

/** This node's slot, or null if it isn't in the node list. */
export function nodeSchedule(nodes: ScheduleNode[], name: string): NodeSchedule | null {
  const index = upgradeOrder(nodes).indexOf(name);
  if (index < 0) return null;
  const bucket = index % UPGRADE_BUCKETS;
  const minutes = FIRST_UPGRADE_MINUTES + BUCKET_MINUTES * bucket;
  return { index, bucket, secondsOfDay: minutes * 60 + nodeJitterSeconds(name) };
}

/** Format seconds-of-day as HH:MM:SS. */
export function formatSecondsOfDay(s: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// --- Time zone arithmetic (Intl/ICU tz database, so DST is handled) ---

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(instantMs: number, tz: string): LocalParts {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second,
  };
}

/** Offset of tz from UTC at an instant, in ms (local = utc + offset). */
function tzOffsetMs(instantMs: number, tz: string): number {
  const p = localParts(instantMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Instant for a local wall-clock time. For a time that occurs twice (DST
 * fall-back) this picks the first occurrence; for one that doesn't exist
 * (spring-forward gap) it lands just after the gap.
 */
export function zonedTimeToInstant(
  year: number, month: number, day: number, secondsOfDay: number, tz: string,
): number {
  const wall = Date.UTC(year, month - 1, day) + secondsOfDay * 1000;
  // Two candidate offsets: the ones in effect a day either side of `wall`.
  const candidates = [tzOffsetMs(wall - 86_400_000, tz), tzOffsetMs(wall + 86_400_000, tz)]
    .map((off) => wall - off)
    .filter((t) => {
      const p = localParts(t, tz);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wall;
    })
    .sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0];
  // Nonexistent local time: shift by the pre-gap offset (lands after the gap).
  return wall - tzOffsetMs(wall - 86_400_000, tz);
}

/** Validate a tz name; returns it, or "UTC" if ICU doesn't know it. */
export function validTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** First occurrence of the local time-of-day strictly after `afterMs`. */
export function nextWindowAfter(afterMs: number, secondsOfDay: number, tz: string): number {
  const p = localParts(afterMs, tz);
  // Today's local date, then step forward a day at a time (at most twice).
  for (let d = 0; d < 3; d++) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    const t = zonedTimeToInstant(
      date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), secondsOfDay, tz,
    );
    if (t > afterMs) return t;
  }
  throw new Error("unreachable: no window within 3 days");
}

/**
 * Did a window start in (prevMs, nowMs]? Windows are only acted on when the
 * agent was running across their start — missed windows don't catch up.
 */
export function windowCrossed(prevMs: number, nowMs: number, secondsOfDay: number, tz: string): boolean {
  return nowMs > prevMs && nextWindowAfter(prevMs, secondsOfDay, tz) <= nowMs;
}
