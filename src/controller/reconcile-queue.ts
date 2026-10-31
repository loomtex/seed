// Per-key work queue with a global concurrency limit.
//
// Used for flake reconciles: different flakes reconcile in parallel (up to
// `concurrency`), but a given flake never has two runs at once. Triggers for a
// key that is already queued merge into the queued entry; triggers for a key
// that is currently running coalesce into exactly one re-run after the
// current run finishes. Keys are dispatched in the order they were first
// queued.

/** Payload for a queued flake reconcile. */
export interface ReconcileJob {
  /** Startup reconcile: prefetch first and hand fetch failures to retryFetch. */
  startup: boolean;
  /** Pass --refresh to nix (webhook-style trigger: the flake may have changed). */
  refresh: boolean;
}

export interface ReconcileQueueOptions<P> {
  /** Maximum number of keys running at once (>= 1). */
  concurrency: number;
  /** Does the work for one key. Rejections are reported to `onError`. */
  run: (key: string, payload: P) => Promise<void>;
  /** Combines the payload of a pending entry with a new trigger's payload. */
  merge: (pending: P, incoming: P) => P;
  /** Called if `run` rejects. Defaults to logging to stderr. */
  onError?: (key: string, err: unknown) => void;
  /** Start paused: triggers are queued (and merged) but nothing runs until resume(). */
  paused?: boolean;
}

export class ReconcileQueue<P> {
  private readonly concurrency: number;
  private readonly runFn: (key: string, payload: P) => Promise<void>;
  private readonly mergeFn: (pending: P, incoming: P) => P;
  private readonly onError: (key: string, err: unknown) => void;

  /** Keys waiting to run (Map preserves first-insertion order). */
  private readonly pending = new Map<string, P>();
  private readonly running = new Set<string>();
  private idleWaiters: Array<() => void> = [];
  private paused: boolean;

  constructor(opts: ReconcileQueueOptions<P>) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`ReconcileQueue concurrency must be a positive integer, got ${opts.concurrency}`);
    }
    this.concurrency = opts.concurrency;
    this.runFn = opts.run;
    this.mergeFn = opts.merge;
    this.onError = opts.onError ?? ((key, err) => console.error(`reconcile queue: ${key}: ${err}`));
    this.paused = opts.paused ?? false;
  }

  /** Start dispatching (no-op if not paused). */
  resume(): void {
    this.paused = false;
    this.pump();
    this.notifyIfIdle();
  }

  /** Queue a run for `key`, merging with any run already waiting for it. */
  enqueue(key: string, payload: P): void {
    const existing = this.pending.get(key);
    this.pending.set(key, existing === undefined ? payload : this.mergeFn(existing, payload));
    this.pump();
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  get runningCount(): number {
    return this.running.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Resolves once nothing is running or waiting (while paused, waits for resume + drain). */
  onIdle(): Promise<void> {
    if (!this.paused && this.running.size === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.paused || this.running.size >= this.concurrency) return;
    for (const [key, payload] of this.pending) {
      if (this.running.size >= this.concurrency) break;
      if (this.running.has(key)) continue; // re-run waits for the current run
      this.pending.delete(key);
      this.start(key, payload);
    }
  }

  private start(key: string, payload: P): void {
    this.running.add(key);
    // Run on a later tick so enqueue() never re-enters caller code synchronously.
    void Promise.resolve()
      .then(() => this.runFn(key, payload))
      .catch((err) => {
        try {
          this.onError(key, err);
        } catch { /* never let error reporting wedge the queue */ }
      })
      .finally(() => {
        this.running.delete(key);
        this.pump();
        this.notifyIfIdle();
      });
  }

  private notifyIfIdle(): void {
    if (this.paused || this.running.size > 0 || this.pending.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}

/** Parse SEED_RECONCILE_CONCURRENCY-style values; falls back on anything not a positive integer. */
export function parseConcurrency(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}
