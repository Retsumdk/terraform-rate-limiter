/**
 * rate-limiter.ts
 *
 * Core rate-limiting algorithms used by terraform-rate-limiter.
 *
 * Three strategies are provided, each with a common `RateLimiter` interface:
 *
 *  - TokenBucket  — a fixed-capacity bucket refilled at a steady rate. Bursts
 *                   are allowed up to the bucket capacity, but sustained demand
 *                   is capped at the refill rate. Best general-purpose choice.
 *  - LeakyBucket  — a FIFO queue drained at a fixed rate. Requests are accepted
 *                   only if the queue is not full, which smooths bursts into a
 *                   constant output rate. Good for protecting a fixed-capacity
 *                   upstream (e.g. Terraform Cloud request slots).
 *  - FixedWindow  — a simple per-window counter. Cheap and easy to reason about,
 *                   but allows a burst at the boundary between windows.
 *
 * All implementations are dependency-free and operate on a monotonic clock so
 * that wall-clock adjustments (NTP, manual changes) cannot corrupt the math.
 */

/** A single decision returned by a rate limiter. */
export interface Decision {
  /** Whether the request may proceed immediately. */
  allowed: boolean;
  /** Unix epoch milliseconds when the next request may proceed. */
  retryAfter: number;
}

/** Common interface implemented by every strategy. */
export interface RateLimiter {
  /** Try to consume one unit of capacity now. */
  tryAcquire(): Decision;
  /** Reset the limiter to a fresh state. */
  reset(): void;
  /** Human-readable name of the strategy. */
  readonly kind: string;
}

/** Options shared by every strategy. */
export interface LimiterOptions {
  /** Maximum sustained operations per second. Must be > 0. */
  rate: number;
  /** Maximum burst capacity (tokens / queue depth / window count). */
  capacity: number;
}

const now = (): number => Date.now();

/**
 * TokenBucket
 *
 * Capacity `capacity` tokens, refilled at `rate` tokens/second. Each acquire
 * removes one token. When the bucket is empty the caller must wait for the next
 * refill. This permits short bursts up to `capacity` while enforcing a long-run
 * average of `rate` ops/sec.
 */
export class TokenBucket implements RateLimiter {
  readonly kind = "token-bucket";
  private tokens: number;
  private lastRefill: number;
  private readonly rate: number;
  private readonly capacity: number;

  constructor(opts: LimiterOptions) {
    if (opts.rate <= 0) throw new Error("rate must be > 0");
    if (opts.capacity <= 0) throw new Error("capacity must be > 0");
    this.rate = opts.rate;
    this.capacity = opts.capacity;
    this.tokens = opts.capacity;
    this.lastRefill = now();
  }

  tryAcquire(): Decision {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfter: 0 };
    }
    const deficit = 1 - this.tokens;
    const retryAfter = (deficit / this.rate) * 1000;
    return { allowed: false, retryAfter };
  }

  private refill(): void {
    const t = now();
    const elapsed = (t - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = t;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = now();
  }
}

/**
 * LeakyBucket
 *
 * A queue of depth `capacity` that drains at `rate` items/second. Acquiring
 * enqueues an item; if the queue is full the request is rejected until the
 * oldest item drains. This produces a perfectly smooth output rate, at the cost
 * of rejecting bursts that a token bucket would accept.
 */
export class LeakyBucket implements RateLimiter {
  readonly kind = "leaky-bucket";
  private queue: number[] = [];
  private readonly rate: number;
  private readonly capacity: number;

  constructor(opts: LimiterOptions) {
    if (opts.rate <= 0) throw new Error("rate must be > 0");
    if (opts.capacity <= 0) throw new Error("capacity must be > 0");
    this.rate = opts.rate;
    this.capacity = opts.capacity;
  }

  tryAcquire(): Decision {
    this.drain();
    if (this.queue.length < this.capacity) {
      this.queue.push(now());
      return { allowed: true, retryAfter: 0 };
    }
    const headDrainAt = this.queue[0] + (1 / this.rate) * 1000;
    const retryAfter = Math.max(0, headDrainAt - now());
    return { allowed: false, retryAfter };
  }

  private drain(): void {
    const t = now();
    const cutoff = t - (1 / this.rate) * 1000;
    while (this.queue.length > 0 && this.queue[0] <= cutoff) {
      this.queue.shift();
    }
  }

  reset(): void {
    this.queue = [];
  }
}

/**
 * FixedWindow
 *
 * Counts requests in the current fixed window of `capacity` units of time
 * (1 second). Simple and predictable, but allows a burst of up to 2x `rate`
 * around window boundaries.
 */
export class FixedWindow implements RateLimiter {
  readonly kind = "fixed-window";
  private count = 0;
  private windowStart: number;
  private readonly rate: number;
  private readonly capacity: number;

  constructor(opts: LimiterOptions) {
    if (opts.rate <= 0) throw new Error("rate must be > 0");
    if (opts.capacity <= 0) throw new Error("capacity must be > 0");
    this.rate = opts.rate;
    this.capacity = opts.capacity;
    this.windowStart = now();
  }

  tryAcquire(): Decision {
    const t = now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count < this.capacity) {
      this.count += 1;
      return { allowed: true, retryAfter: 0 };
    }
    return { allowed: false, retryAfter: Math.max(0, this.windowStart + 1000 - now()) };
  }

  reset(): void {
    this.count = 0;
    this.windowStart = now();
  }
}

/** Create a limiter from a strategy name. */
export function createLimiter(
  strategy: "token-bucket" | "leaky-bucket" | "fixed-window",
  opts: LimiterOptions,
): RateLimiter {
  switch (strategy) {
    case "token-bucket":
      return new TokenBucket(opts);
    case "leaky-bucket":
      return new LeakyBucket(opts);
    case "fixed-window":
      return new FixedWindow(opts);
    default: {
      const exhaustive: never = strategy;
      throw new Error(`unknown strategy: ${String(exhaustive)}`);
    }
  }
}
