import { describe, test, expect } from "bun:test";
import { Limiter, RateLimitError } from "../src/limiter.ts";

describe("Limiter", () => {
  test("runs a task successfully when under the limit", async () => {
    const limiter = new Limiter({ strategy: "token-bucket", rate: 100, capacity: 100 });
    const result = await limiter.run(async () => 42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(result.retries).toBe(0);
  });

  test("retries on RateLimitError and eventually succeeds", async () => {
    const limiter = new Limiter({ strategy: "token-bucket", rate: 1000, capacity: 1000 });
    let calls = 0;
    const result = await limiter.run(async () => {
      calls += 1;
      if (calls < 3) throw new RateLimitError(1);
      return "done";
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe("done");
    expect(result.retries).toBe(2);
  });

  test("gives up after maxRetries", async () => {
    const limiter = new Limiter({ strategy: "token-bucket", rate: 1000, capacity: 1000, maxRetries: 2 });
    const result = await limiter.run(async () => {
      throw new RateLimitError(1);
    });
    expect(result.ok).toBe(false);
    expect(result.retries).toBe(2);
    expect(result.error).toBeInstanceOf(RateLimitError);
  });

  test("does not retry non-rate-limit errors", async () => {
    const limiter = new Limiter({ strategy: "token-bucket", rate: 1000, capacity: 1000, maxRetries: 3 });
    let calls = 0;
    const result = await limiter.run(async () => {
      calls += 1;
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });
});
