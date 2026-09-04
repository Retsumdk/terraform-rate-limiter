/**
 * limiter.ts
 *
 * A higher-level `Limiter` that combines a core rate-limiting strategy with
 * retry/backoff and optional concurrency limiting. This is the object most
 * consumers interact with: it exposes `run()` which acquires a slot, executes
 * your task, and transparently retries on upstream rate-limit (429) responses.
 */

import type { RateLimiter } from "./rate-limiter.ts";
import { createLimiter } from "./rate-limiter.ts";

export interface LimiterConfig {
  /** Core strategy: token-bucket | leaky-bucket | fixed-window */
  strategy?: "token-bucket" | "leaky-bucket" | "fixed-window";
  /** Sustained operations per second. */
  rate: number;
  /** Burst capacity. */
  capacity: number;
  /** Maximum automatic retries on 429 responses. Default 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default 200. */
  baseDelayMs?: number;
  /** Maximum concurrency (parallel in-flight tasks). Default 1. */
  concurrency?: number;
}

export interface RunResult<T> {
  ok: boolean;
  value?: T;
  /** Number of retries that were performed. */
  retries: number;
  /** Total wall-clock time spent in ms. */
  elapsedMs: number;
  error?: unknown;
}

/** Error thrown when a task is rejected by the rate limiter and retries are exhausted. */
export class RateLimitError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`rate limit exceeded; retry after ${retryAfter}ms`);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Limiter {
  private readonly bucket: RateLimiter;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly concurrency: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(cfg: LimiterConfig) {
    this.bucket = createLimiter(cfg.strategy ?? "token-bucket", {
      rate: cfg.rate,
      capacity: cfg.capacity,
    });
    this.maxRetries = cfg.maxRetries ?? 3;
    this.baseDelayMs = cfg.baseDelayMs ?? 200;
    this.concurrency = cfg.concurrency ?? 1;
  }

  get strategy(): string {
    return this.bucket.kind;
  }

  /**
   * Run `task`, respecting the rate limit and retrying on 429 responses.
   *
   * A task may signal an upstream rate limit by throwing `RateLimitError` (or
   * by returning an object with `status === 429`). In both cases the limiter
   * backs off and retries up to `maxRetries` times.
   */
  async run<T>(task: () => Promise<T>): Promise<RunResult<T>> {
    const started = Date.now();
    let retries = 0;

    await this.acquireSlot();
    try {
      for (;;) {
        const decision = this.bucket.tryAcquire();
        if (!decision.allowed) {
          await sleep(Math.max(0, decision.retryAfter - Date.now()));
          continue;
        }

        try {
          const value = await task();
          return { ok: true, value, retries, elapsedMs: Date.now() - started };
        } catch (err) {
          const retryAfter = this.isRateLimit(err);
          if (retryAfter === null || retries >= this.maxRetries) {
            return { ok: false, retries, elapsedMs: Date.now() - started, error: err };
          }
          retries += 1;
          const delay = this.baseDelayMs * 2 ** (retries - 1);
          await sleep(Math.max(delay, retryAfter));
        }
      }
    } finally {
      this.releaseSlot();
    }
  }

  /** Wait until a concurrency slot is available. */
  private async acquireSlot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Return retry-after ms if `err` looks like an upstream 429, else null. */
  private isRateLimit(err: unknown): number | null {
    if (err instanceof RateLimitError) return err.retryAfter;
    if (
      err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status: number }).status === 429
    ) {
      return 0;
    }
    return null;
  }

  reset(): void {
    this.bucket.reset();
  }
}
