// Retries flakes whose source couldn't be fetched (silo restarting, cold
// start) until a probe succeeds, then hands them back for a reconcile.
//
// At most one retry loop per flake: a burst of failed reconciles for the same
// unreachable source shares the loop already running instead of stacking
// timers. Backoff doubles from `initialDelay` up to `maxDelay`.

export interface FetchRetrierOptions {
  /** Resolves when the flake's source is reachable, rejects otherwise. */
  probe: (key: string) => Promise<void>;
  /** Called once the probe succeeds (e.g. queue a reconcile). */
  onReachable: (key: string) => void;
  log: (key: string, msg: string) => void;
  initialDelay?: number;
  maxDelay?: number;
  /** Timer hook for tests; defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

export class FetchRetrier {
  private readonly active = new Set<string>();
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly opts: FetchRetrierOptions) {
    this.initialDelay = opts.initialDelay ?? 30_000;
    this.maxDelay = opts.maxDelay ?? 600_000;
    this.schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref(); });
  }

  /** Start retrying `key`. Returns false if a retry loop for it is already running. */
  start(key: string): boolean {
    if (this.active.has(key)) return false;
    this.active.add(key);
    this.opts.log(key, `flake fetch failed, retrying in ${this.initialDelay / 1000}s`);
    this.attempt(key, this.initialDelay);
    return true;
  }

  isRetrying(key: string): boolean {
    return this.active.has(key);
  }

  private attempt(key: string, delay: number): void {
    this.schedule(async () => {
      try {
        await this.opts.probe(key);
      } catch (err) {
        const next = Math.min(delay * 2, this.maxDelay);
        this.opts.log(key, `flake fetch failed, retrying in ${next / 1000}s: ${err}`);
        this.attempt(key, next);
        return;
      }
      this.active.delete(key);
      this.opts.log(key, "flake source reachable, queueing reconciliation");
      this.opts.onReachable(key);
    }, delay);
  }
}
