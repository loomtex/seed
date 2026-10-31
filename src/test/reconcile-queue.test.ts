// Tests for the per-flake reconcile queue (src/controller/reconcile-queue.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReconcileQueue, parseConcurrency, type ReconcileJob } from "../controller/reconcile-queue.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let queued microtasks/then-chains settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Harness: every run() call blocks until the test releases it, and calls are
 * recorded with their payload so tests can assert on scheduling decisions.
 */
function harness(concurrency: number, opts: { paused?: boolean } = {}) {
  const calls: Array<{ key: string; payload: ReconcileJob; done: Deferred }> = [];
  let active = 0;
  let maxActive = 0;
  const activeByKey = new Map<string, number>();
  let overlap = false;
  const errors: Array<[string, unknown]> = [];

  const queue = new ReconcileQueue<ReconcileJob>({
    concurrency,
    paused: opts.paused,
    merge: (a, b) => ({ startup: a.startup || b.startup, refresh: a.refresh || b.refresh }),
    onError: (key, err) => errors.push([key, err]),
    run: async (key, payload) => {
      const done = deferred();
      calls.push({ key, payload, done });
      active++;
      maxActive = Math.max(maxActive, active);
      const k = (activeByKey.get(key) ?? 0) + 1;
      activeByKey.set(key, k);
      if (k > 1) overlap = true;
      try {
        await done.promise;
      } finally {
        active--;
        activeByKey.set(key, activeByKey.get(key)! - 1);
      }
    },
  });

  return {
    queue,
    calls,
    errors,
    get maxActive() { return maxActive; },
    get overlap() { return overlap; },
    /** Release the oldest unreleased run of `key`. */
    release(key: string, err?: unknown) {
      const c = calls.find((x) => x.key === key && !(x as { released?: boolean }).released);
      assert.ok(c, `no running call for ${key}`);
      (c as { released?: boolean }).released = true;
      if (err === undefined) c.done.resolve(); else c.done.reject(err);
    },
  };
}

const hook: ReconcileJob = { startup: false, refresh: true };
const boot: ReconcileJob = { startup: true, refresh: false };

describe("ReconcileQueue", () => {
  it("runs different keys concurrently up to the limit", async () => {
    const h = harness(2);
    h.queue.enqueue("a", hook);
    h.queue.enqueue("b", hook);
    h.queue.enqueue("c", hook);
    await flush();
    assert.deepEqual(h.calls.map((c) => c.key), ["a", "b"]);
    assert.equal(h.queue.runningCount, 2);
    assert.equal(h.queue.pendingCount, 1);

    h.release("a");
    await flush();
    assert.deepEqual(h.calls.map((c) => c.key), ["a", "b", "c"]);
    h.release("b");
    h.release("c");
    await h.queue.onIdle();
    assert.equal(h.maxActive, 2);
  });

  it("never runs the same key twice at once", async () => {
    const h = harness(3);
    h.queue.enqueue("a", hook);
    await flush();
    h.queue.enqueue("a", hook);
    h.queue.enqueue("b", hook);
    await flush();
    // "a" is running, its re-run must wait even though slots are free.
    assert.deepEqual(h.calls.map((c) => c.key), ["a", "b"]);
    assert.ok(h.queue.isRunning("a"));
    assert.ok(h.queue.isPending("a"));
    h.release("a");
    await flush();
    assert.deepEqual(h.calls.map((c) => c.key), ["a", "b", "a"]);
    h.release("a");
    h.release("b");
    await h.queue.onIdle();
    assert.equal(h.overlap, false);
  });

  it("coalesces triggers during a run into exactly one re-run", async () => {
    const h = harness(3);
    h.queue.enqueue("a", hook);
    await flush();
    for (let i = 0; i < 5; i++) h.queue.enqueue("a", hook);
    h.release("a");
    await flush();
    h.release("a");
    await h.queue.onIdle();
    assert.equal(h.calls.filter((c) => c.key === "a").length, 2);
  });

  it("merges payloads of a queued entry", async () => {
    const h = harness(1);
    h.queue.enqueue("x", hook); // occupies the only slot
    await flush();
    h.queue.enqueue("a", boot);
    h.queue.enqueue("a", hook);
    h.release("x");
    await flush();
    const a = h.calls.find((c) => c.key === "a")!;
    assert.deepEqual(a.payload, { startup: true, refresh: true });
    h.release("a");
    await h.queue.onIdle();
  });

  it("dispatches in first-queued order", async () => {
    const h = harness(1);
    h.queue.enqueue("a", hook);
    h.queue.enqueue("b", hook);
    h.queue.enqueue("c", hook);
    h.queue.enqueue("b", hook); // re-trigger does not move b
    for (const k of ["a", "b", "c"]) {
      await flush();
      h.release(k);
    }
    await h.queue.onIdle();
    assert.deepEqual(h.calls.map((c) => c.key), ["a", "b", "c"]);
  });

  it("holds work while paused and merges triggers until resume", async () => {
    const h = harness(2, { paused: true });
    h.queue.enqueue("a", hook);
    h.queue.enqueue("a", boot);
    h.queue.enqueue("b", boot);
    await flush();
    assert.equal(h.calls.length, 0);
    let idle = false;
    void h.queue.onIdle().then(() => { idle = true; });
    await flush();
    assert.equal(idle, false, "a paused queue with work is not idle");

    h.queue.resume();
    await flush();
    assert.deepEqual(h.calls.map((c) => [c.key, c.payload]), [
      ["a", { startup: true, refresh: true }],
      ["b", { startup: true, refresh: false }],
    ]);
    h.release("a");
    h.release("b");
    await flush();
    assert.equal(idle, true);
  });

  it("resolves onIdle on resume when nothing was queued", async () => {
    const h = harness(1, { paused: true });
    let idle = false;
    void h.queue.onIdle().then(() => { idle = true; });
    h.queue.resume();
    await flush();
    assert.equal(idle, true);
  });

  it("keeps going after a run rejects and frees the key", async () => {
    const h = harness(1);
    h.queue.enqueue("a", hook);
    h.queue.enqueue("b", hook);
    await flush();
    h.release("a", new Error("boom"));
    await flush();
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0]![0], "a");
    assert.deepEqual(h.calls.map((c) => c.key), ["a", "b"]);
    h.queue.enqueue("a", hook);
    h.release("b");
    await flush();
    assert.deepEqual(h.calls.map((c) => c.key), ["a", "b", "a"]);
    h.release("a");
    await h.queue.onIdle();
  });

  it("survives a throwing onError", async () => {
    let runs = 0;
    const q = new ReconcileQueue<null>({
      concurrency: 1,
      merge: () => null,
      run: async () => { runs++; throw new Error("run failed"); },
      onError: () => { throw new Error("reporter failed"); },
    });
    q.enqueue("a", null);
    await q.onIdle();
    q.enqueue("a", null);
    await q.onIdle();
    assert.equal(runs, 2);
  });

  it("does not call run synchronously from enqueue", () => {
    let ran = false;
    const q = new ReconcileQueue<null>({
      concurrency: 1,
      merge: () => null,
      run: async () => { ran = true; },
    });
    q.enqueue("a", null);
    assert.equal(ran, false);
    assert.ok(q.isRunning("a"));
  });

  it("rejects a non-positive concurrency", () => {
    for (const c of [0, -1, 1.5, NaN]) {
      assert.throws(() => new ReconcileQueue<null>({ concurrency: c, merge: () => null, run: async () => {} }));
    }
  });
});

describe("parseConcurrency", () => {
  it("uses the fallback for unset, empty or invalid values", () => {
    assert.equal(parseConcurrency(undefined, 3), 3);
    assert.equal(parseConcurrency("", 3), 3);
    assert.equal(parseConcurrency("  ", 3), 3);
    assert.equal(parseConcurrency("0", 3), 3);
    assert.equal(parseConcurrency("-2", 3), 3);
    assert.equal(parseConcurrency("2.5", 3), 3);
    assert.equal(parseConcurrency("lots", 3), 3);
  });

  it("parses positive integers", () => {
    assert.equal(parseConcurrency("1", 3), 1);
    assert.equal(parseConcurrency(" 6 ", 3), 6);
  });
});
