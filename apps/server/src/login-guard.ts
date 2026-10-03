/**
 * Per-key login failure tracker with escalating lockout. Complements the
 * per-window rate limiter: the limiter bounds steady-state attempts, this adds
 * exponential backoff once an IP accumulates consecutive failures.
 */
export class LoginGuard {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly threshold = 5,
    private readonly baseLockMs = 60_000,
    private readonly maxLockMs = 30 * 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** Milliseconds the key must wait, or 0 if it may try now. */
  retryAfterMs(key: string, now = Date.now()): number {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    return entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  }

  /** Register a failed attempt; returns the remaining lockout in ms. */
  recordFailure(key: string, now = Date.now()): number {
    const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= this.threshold) {
      const stepsOver = entry.count - this.threshold;
      const lock = Math.min(this.baseLockMs * 2 ** stepsOver, this.maxLockMs);
      entry.lockedUntil = now + lock;
    }
    if (this.failures.size >= this.maxKeys) this.prune(now);
    this.failures.set(key, entry);
    return entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.failures) {
      if (entry.lockedUntil <= now && entry.count < this.threshold) this.failures.delete(key);
    }
  }

  start(): void {
    this.timer = setInterval(() => this.prune(), 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.failures.clear();
  }
}
