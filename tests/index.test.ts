import { describe, test, expect } from "bun:test";
import { buildRunCommand, parseRateArgs } from "../src/cli.ts";

describe("cli", () => {
  test("parseRateArgs parses rate and capacity", () => {
    const args = ["--rate", "20", "--capacity", "5"];
    const parsed = parseRateArgs(args);
    expect(parsed.rate).toBe(20);
    expect(parsed.capacity).toBe(5);
  });

  test("parseRateArgs applies defaults", () => {
    const parsed = parseRateArgs([]);
    expect(parsed.rate).toBe(10);
    expect(parsed.capacity).toBe(10);
  });

  test("buildRunCommand wraps a command string", () => {
    const cmd = buildRunCommand("terraform plan", 10, 5);
    expect(cmd).toContain("terraform plan");
    expect(cmd).toContain("--rate 10");
    expect(cmd).toContain("--capacity 5");
  });
});
