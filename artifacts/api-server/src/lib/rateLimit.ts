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
    /** Most keys kept at once; past it the oldest window is dropped, so rotating keys cannot exhaust memory. */
    readonly maxKeys = 100_000,
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
    if (b) {
      b.count++;
      return;
    }
    if (this.buckets.size >= this.maxKeys) {
      this.sweep(now);
      // Map iteration is insertion order: the first key has the oldest window.
      while (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
    this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  /** Number of keys currently held (for tests). */
  get size(): number {
    return this.buckets.size;
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

  sweep(now = Date.now()): void {
    for (const [key, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(key);
  }
}

/** Expands an IPv6 address to its 8 hextets, or null when it is not one. */
function ipv6Hextets(addr: string): number[] | null {
  let a = addr;
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two hextets.
  const v4 = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(2).map(Number);
    if ([b0, b1, b2, b3].some((n) => n > 255)) return null;
    a = `${v4[1]}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The key a client address is counted under: IPv4 as is (an IPv4-mapped IPv6 address
 * "::ffff:1.2.3.4" becomes "1.2.3.4"), IPv6 by its /64 network, since one host or
 * customer usually holds a whole /64 and could otherwise rotate through addresses.
 */
export function rateLimitIpKey(ip: string): string {
  const addr = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!addr.includes(":")) return addr;
  const h = ipv6Hextets(addr);
  if (!h) return addr.toLowerCase();
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  }
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Failed-login limits (configurable for tests):
 *   LOGIN_MAX_FAILURES_PER_EMAIL    failed attempts per (IP, email) per window, default 5
 *   LOGIN_MAX_FAILURES_PER_IP       failed attempts per IP per window, default 50
 *   LOGIN_MAX_FAILURES_PER_ACCOUNT  failed attempts per email from all IPs together, default 20
 *                                   (higher than the per-IP one, so one attacker IP alone cannot
 *                                   lock the owner out; it caps guessing from many addresses)
 *   LOGIN_FAILURE_WINDOW_MINUTES    window length, default 15
 * IPs are counted by rateLimitIpKey() (IPv6 per /64). Successful logins are never counted.
 */
export class LoginRateLimiter {
  readonly perEmail: FailureCounter;
  readonly perIp: FailureCounter;
  readonly perAccount: FailureCounter;

  constructor(opts?: { maxPerEmail?: number; maxPerIp?: number; maxPerAccount?: number; windowMs?: number; maxKeys?: number }) {
    const windowMs = opts?.windowMs ?? envInt("LOGIN_FAILURE_WINDOW_MINUTES", 15) * 60_000;
    this.perEmail = new FailureCounter(opts?.maxPerEmail ?? envInt("LOGIN_MAX_FAILURES_PER_EMAIL", 5), windowMs, opts?.maxKeys);
    this.perIp = new FailureCounter(opts?.maxPerIp ?? envInt("LOGIN_MAX_FAILURES_PER_IP", 50), windowMs, opts?.maxKeys);
    this.perAccount = new FailureCounter(opts?.maxPerAccount ?? envInt("LOGIN_MAX_FAILURES_PER_ACCOUNT", 20), windowMs, opts?.maxKeys);
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
  begin(rawIp: string, email: string): number {
    const ip = rateLimitIpKey(rawIp);
    const key = LoginRateLimiter.emailKey(ip, email);
    const wait = Math.max(this.perIp.retryAfter(ip), this.perEmail.retryAfter(key), this.perAccount.retryAfter(email));
    if (wait > 0) return wait;
    this.perIp.hit(ip);
    this.perEmail.hit(key);
    this.perAccount.hit(email);
    return 0;
  }

  /**
   * The password was right: successful logins are never counted. Undoes the IP
   * reservation and clears that (IP, email) counter and the account counter (the
   * owner got in; earlier failures from the same IP for other emails still count).
   */
  succeeded(rawIp: string, email: string): void {
    const ip = rateLimitIpKey(rawIp);
    this.perIp.release(ip);
    this.perEmail.reset(LoginRateLimiter.emailKey(ip, email));
    this.perAccount.reset(email);
  }
}

/** "about 1 minute" / "about 12 minutes" for the 429 message. */
export function describeWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}
