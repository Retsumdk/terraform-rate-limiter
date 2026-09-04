/**
 * cli.ts — shared CLI helpers for terraform-rate-limiter
 *
 * These functions are factored out of the command entry point so they can be
 * unit-tested without spawning a shell.
 */

export type StrategyName = "token-bucket" | "leaky-bucket" | "fixed-window";

/** Parse -r/--rate and -c/--capacity from an argv-style list, applying defaults. */
export function parseRateArgs(args: string[]): { rate: number; capacity: number } {
  let rate = 10;
  let capacity = 10;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--rate" || arg === "-r") rate = parseFloat(args[++i] ?? "10");
    else if (arg === "--capacity" || arg === "-c") capacity = parseFloat(args[++i] ?? "10");
  }
  return { rate: Number.isFinite(rate) ? rate : 10, capacity: Number.isFinite(capacity) ? capacity : 10 };
}

/** Build a shell command string that runs `command` under the given limit. */
export function buildRunCommand(command: string, rate: number, capacity: number): string {
  return `terraform-rate-limiter run --rate ${rate} --capacity ${capacity} "${command}"`;
}

/** Validate a strategy name, throwing on an unknown value. */
export function parseStrategy(value: string): StrategyName {
  if (value === "token-bucket" || value === "leaky-bucket" || value === "fixed-window") {
    return value;
  }
  throw new Error(`unknown strategy '${value}' (use token-bucket, leaky-bucket, or fixed-window)`);
}
