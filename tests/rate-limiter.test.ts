import { describe, test, expect } from "bun:test";
import {
  TokenBucket,
  LeakyBucket,
  FixedWindow,
  createLimiter,
  type RateLimiter,
} from "../src/rate-limiter.ts";

describe("TokenBucket", () => {
  test("allows up to capacity immediate acquisitions", () => {
    const b = new TokenBucket({ rate: 10, capacity: 5 });
    for (let i = 0; i < 5; i++) {
      expect(b.tryAcquire().allowed).toBe(true);
    }
  });

  test("denies once the bucket is empty", () => {
    const b = new TokenBucket({ rate: 10, capacity: 1 });
    expect(b.tryAcquire().allowed).toBe(true);
    expect(b.tryAcquire().allowed).toBe(false);
  });

  test("returns the refill duration as retryAfter when denied", () => {
    const b = new TokenBucket({ rate: 10, capacity: 1 });
    b.tryAcquire();
    const d = b.tryAcquire();
    expect(d.allowed).toBe(false);
    // retryAfter is the number of ms until a token refills, not an epoch ms.
    expect(d.retryAfter).toBeGreaterThan(0);
    expect(d.retryAfter).toBeLessThan(10_000);
  });

  test("rejects invalid configuration", () => {
    expect(() => new TokenBucket({ rate: 0, capacity: 1 })).toThrow();
    expect(() => new TokenBucket({ rate: 1, capacity: 0 })).toThrow();
  });
});

describe("LeakyBucket", () => {
  test("accepts up to capacity queued requests", () => {
    const b = new LeakyBucket({ rate: 10, capacity: 3 });
    for (let i = 0; i < 3; i++) {
      expect(b.tryAcquire().allowed).toBe(true);
    }
  });

  test("rejects when the queue is full", () => {
    const b = new LeakyBucket({ rate: 1000, capacity: 2 });
    b.tryAcquire();
    b.tryAcquire();
    expect(b.tryAcquire().allowed).toBe(false);
  });

  test("rejects invalid configuration", () => {
    expect(() => new LeakyBucket({ rate: 0, capacity: 1 })).toThrow();
  });
});

describe("FixedWindow", () => {
  test("allows up to capacity per window", () => {
    const b = new FixedWindow({ rate: 5, capacity: 3 });
    for (let i = 0; i < 3; i++) {
      expect(b.tryAcquire().allowed).toBe(true);
    }
    expect(b.tryAcquire().allowed).toBe(false);
  });
});

describe("createLimiter", () => {
  test("constructs each supported strategy", () => {
    const strategies: Array<"token-bucket" | "leaky-bucket" | "fixed-window"> = [
      "token-bucket",
      "leaky-bucket",
      "fixed-window",
    ];
    for (const s of strategies) {
      const l: RateLimiter = createLimiter(s, { rate: 10, capacity: 5 });
      expect(l.kind).toBe(s);
    }
  });

  test("throws on unknown strategy", () => {
    expect(() =>
      createLimiter("unknown" as never, { rate: 10, capacity: 5 }),
    ).toThrow();
  });
});

describe("retryAfter is a duration, not a timestamp", () => {
  test("TokenBucket returns a small retry-after when denied", () => {
    const b = new TokenBucket({ rate: 1, capacity: 1 });
    b.tryAcquire(); // consume the only token
    const d = b.tryAcquire(); // denied
    expect(d.allowed).toBe(false);
    expect(d.retryAfter).toBeGreaterThan(0);
    expect(d.retryAfter).toBeLessThan(10_000); // a duration, not an epoch ms
  });

  test("FixedWindow returns a bounded retry-after when denied", () => {
    const w = new FixedWindow({ rate: 1, capacity: 1 });
    w.tryAcquire();
    const d = w.tryAcquire();
    expect(d.allowed).toBe(false);
    expect(d.retryAfter).toBeGreaterThan(0);
    expect(d.retryAfter).toBeLessThan(10_000);
  });

  test("LeakyBucket returns a bounded retry-after when full", () => {
    const l = new LeakyBucket({ rate: 1, capacity: 1 });
    l.tryAcquire();
    const d = l.tryAcquire();
    expect(d.allowed).toBe(false);
    expect(d.retryAfter).toBeGreaterThan(0);
    expect(d.retryAfter).toBeLessThan(10_000);
  });
});
