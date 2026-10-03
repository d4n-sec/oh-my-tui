/**
 * Minimal in-memory per-key sliding-window rate limiter for the unauthenticated
 * enrollment endpoints. Keys are source IPs; `limit <= 0` disables limiting.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    if (this.limit <= 0) return true;
    const cutoff = now - this.windowMs;
    let window = this.hits.get(key);
    if (!window) {
      window = [];
      this.hits.set(key, window);
    }
    while (window.length > 0 && window[0]! <= cutoff) window.shift();
    if (window.length >= this.limit) return false;
    window.push(now);
    return true;
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, window] of this.hits) {
      while (window.length > 0 && window[0]! <= cutoff) window.shift();
      if (window.length === 0) this.hits.delete(key);
    }
  }

  start(): void {
    this.timer = setInterval(() => this.prune(), this.windowMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.hits.clear();
  }

  /** Exposed for tests. */
  size(): number {
    return this.hits.size;
  }
}
