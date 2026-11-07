/**
 * Small in-memory fixed-window counters (single process; resets on restart).
 * Used to slow down password guessing on POST /api/auth/login.
 */

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

export class FailureCounter {
  private buckets = new Map<string, Bucket>();
  private sweeper: NodeJS.Timeout;

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {
    // Drop expired buckets now and then so the map cannot grow without bound.
    this.sweeper = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.sweeper.unref();
  }

  private live(key: string, now: number): Bucket | undefined {
    const b = this.buckets.get(key);
    if (b && b.resetAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return b;
  }

  /** Seconds until `key` may try again, or 0 when it is not blocked. */
  retryAfter(key: string, now = Date.now()): number {
    const b = this.live(key, now);
    if (!b || b.count < this.max) return 0;
    return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  }

  /** Records one failure. The window starts at the first failure. */
  hit(key: string, now = Date.now()): void {
    const b = this.live(key, now);
    if (b) b.count++;
    else this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  /** Takes back one earlier hit (used to undo a reservation). */
  release(key: string, now = Date.now()): void {
    const b = this.live(key, now);
    if (!b) return;
    if (b.count <= 1) this.buckets.delete(key);
    else b.count--;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now = Date.now()): void {
    for (const [key, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(key);
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Failed-login limits (configurable for tests):
 *   LOGIN_MAX_FAILURES_PER_EMAIL  failed attempts per (IP, email) per window, default 5
 *   LOGIN_MAX_FAILURES_PER_IP     failed attempts per IP per window, default 50
 *   LOGIN_FAILURE_WINDOW_MINUTES  window length, default 15
 * Successful logins are never counted.
 */
export class LoginRateLimiter {
  readonly perEmail: FailureCounter;
  readonly perIp: FailureCounter;

  constructor(opts?: { maxPerEmail?: number; maxPerIp?: number; windowMs?: number }) {
    const windowMs = opts?.windowMs ?? envInt("LOGIN_FAILURE_WINDOW_MINUTES", 15) * 60_000;
    this.perEmail = new FailureCounter(opts?.maxPerEmail ?? envInt("LOGIN_MAX_FAILURES_PER_EMAIL", 5), windowMs);
    this.perIp = new FailureCounter(opts?.maxPerIp ?? envInt("LOGIN_MAX_FAILURES_PER_IP", 50), windowMs);
  }

  private static emailKey(ip: string, email: string): string {
    return `${ip}\u0000${email}`;
  }

  /**
   * Call before checking the password. Returns the seconds to wait (and reserves
   * nothing) when the IP or the (IP, email) pair is blocked. Otherwise returns 0
   * and counts the attempt as a failure up front, so a burst of parallel guesses
   * cannot all slip past the check before the first one has failed; succeeded()
   * takes the reservation back.
   */
  begin(ip: string, email: string): number {
    const key = LoginRateLimiter.emailKey(ip, email);
    const wait = Math.max(this.perIp.retryAfter(ip), this.perEmail.retryAfter(key));
    if (wait > 0) return wait;
    this.perIp.hit(ip);
    this.perEmail.hit(key);
    return 0;
  }

  /**
   * The password was right: successful logins are never counted. Undoes the IP
   * reservation and clears that (IP, email) counter (earlier failures from the
   * same IP for other emails still count).
   */
  succeeded(ip: string, email: string): void {
    this.perIp.release(ip);
    this.perEmail.reset(LoginRateLimiter.emailKey(ip, email));
  }
}

/** "about 1 minute" / "about 12 minutes" for the 429 message. */
export function describeWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}
