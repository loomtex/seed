// Tests for the flake fetch retrier (src/controller/fetch-retry.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FetchRetrier } from "../controller/fetch-retry.js";

/** Let queued microtasks/then-chains settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Harness: timers are captured instead of run, so tests fire them one at a
 * time; the probe fails while `reachable` is false.
 */
function harness(opts: { initialDelay?: number; maxDelay?: number } = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const probes: string[] = [];
  const reached: string[] = [];
  const state = { reachable: false };
  const retrier = new FetchRetrier({
    probe: async (key) => {
      probes.push(key);
      if (!state.reachable) throw new Error("connection refused");
    },
    onReachable: (key) => reached.push(key),
    log: () => {},
    schedule: (fn, ms) => timers.push({ fn, ms }),
    ...opts,
  });
  async function fireNext(): Promise<number> {
    const t = timers.shift();
    assert.ok(t, "expected a pending timer");
    t.fn();
    await flush();
    return t.ms;
  }
  return { retrier, timers, probes, reached, state, fireNext };
}

describe("FetchRetrier", () => {
  it("probes after the initial delay and hands the flake back once reachable", async () => {
    const h = harness({ initialDelay: 30_000 });
    assert.equal(h.retrier.start("silo:a"), true);
    assert.deepEqual(h.timers.map((t) => t.ms), [30_000]);
    assert.deepEqual(h.probes, [], "no probe before the first timer fires");

    h.state.reachable = true;
    await h.fireNext();
    assert.deepEqual(h.probes, ["silo:a"]);
    assert.deepEqual(h.reached, ["silo:a"]);
    assert.equal(h.retrier.isRetrying("silo:a"), false);
    assert.equal(h.timers.length, 0, "no further timer after success");
  });

  it("doubles the delay on each failed probe, capped at maxDelay", async () => {
    const h = harness({ initialDelay: 30_000, maxDelay: 100_000 });
    h.retrier.start("silo:a");
    const delays = [await h.fireNext(), await h.fireNext(), await h.fireNext()];
    assert.deepEqual(delays, [30_000, 60_000, 100_000]);
    assert.deepEqual(h.timers.map((t) => t.ms), [100_000]);
    assert.deepEqual(h.reached, []);
    assert.equal(h.retrier.isRetrying("silo:a"), true);
  });

  it("keeps one loop per flake while it is retrying", async () => {
    const h = harness();
    assert.equal(h.retrier.start("silo:a"), true);
    assert.equal(h.retrier.start("silo:a"), false);
    await h.fireNext();
    assert.equal(h.retrier.start("silo:a"), false, "still retrying after a failed probe");
    assert.equal(h.timers.length, 1);
  });

  it("allows a new loop after the previous one succeeded", async () => {
    const h = harness();
    h.retrier.start("silo:a");
    h.state.reachable = true;
    await h.fireNext();
    h.state.reachable = false;
    assert.equal(h.retrier.start("silo:a"), true);
    assert.equal(h.timers.length, 1);
  });

  it("retries different flakes independently", async () => {
    const h = harness();
    h.retrier.start("silo:a");
    h.retrier.start("silo:b");
    assert.equal(h.timers.length, 2);
    h.state.reachable = true;
    await h.fireNext();
    await h.fireNext();
    assert.deepEqual(h.reached.sort(), ["silo:a", "silo:b"]);
  });
});
