#!/usr/bin/env bun
/**
 * index.ts — terraform-rate-limiter CLI
 *
 * Commands:
 *   run       Wrap a shell command so it runs under a configured rate limit.
 *   limit     Simulate a rate-limit config and print the decisions it makes.
 *   bench     Benchmark the throughput of a strategy under a given load.
 *   request   Make a rate-limited request to the Terraform Cloud API.
 *
 * Examples:
 *   terraform-rate-limiter run -r 5 "terraform plan"
 *   terraform-rate-limiter limit -r 5 -c 10 -n 25
 *   terraform-rate-limiter bench -r 100 -c 200 -n 1000
 *   terraform-rate-limiter request -t $TFC_TOKEN /organizations
 */

import { Command } from "commander";
import { spawn } from "node:child_process";
import { parseStrategy, type StrategyName } from "./cli.ts";
import { createLimiter, type RateLimiter } from "./rate-limiter.ts";
import { Limiter } from "./limiter.ts";
import { TerraformClient } from "./terraform.ts";

const program = new Command();
program
  .name("terraform-rate-limiter")
  .description(
    "Rate-limit Terraform Cloud/Enterprise API requests and arbitrary commands.",
  )
  .version("1.0.0");

program
  .command("run")
  .description("Run a shell command under a rate limit.")
  .requiredOption("-r, --rate <n>", "operations per second", parseFloat)
  .option("-c, --capacity <n>", "burst capacity", parseFloat, 10)
  .option("-s, --strategy <name>", "token-bucket | leaky-bucket | fixed-window", parseStrategy, "token-bucket")
  .argument("<command>", "shell command to run")
  .action(async (command: string, opts: { rate: number; capacity: number; strategy: StrategyName }) => {
    const limiter = new Limiter({
      strategy: opts.strategy,
      rate: opts.rate,
      capacity: opts.capacity,
    });
    const started = Date.now();
    const result = await limiter.run(() =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 0));
      }),
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    if (!result.ok) {
      console.error(`command failed after ${result.retries} retries: ${result.error}`);
      process.exit(1);
    }
    console.log(`\n[terraform-rate-limiter] exit=${result.value} retries=${result.retries} elapsed=${elapsed}s`);
    process.exit(result.value ?? 0);
  });

program
  .command("limit")
  .description("Simulate a rate-limit config and print each decision.")
  .requiredOption("-r, --rate <n>", "operations per second", parseFloat)
  .option("-c, --capacity <n>", "burst capacity", parseFloat, 10)
  .option("-s, --strategy <name>", "token-bucket | leaky-bucket | fixed-window", parseStrategy, "token-bucket")
  .option("-n, --count <n>", "number of requests to simulate", parseFloat, 20)
  .action((opts: { rate: number; capacity: number; strategy: StrategyName; count: number }) => {
    const limiter: RateLimiter = createLimiter(opts.strategy, {
      rate: opts.rate,
      capacity: opts.capacity,
    });
    let allowed = 0;
    const rows: string[] = [];
    for (let i = 1; i <= opts.count; i++) {
      const d = limiter.tryAcquire();
      if (d.allowed) allowed += 1;
      rows.push(
        `  ${String(i).padStart(3)}  ${d.allowed ? "ALLOWED" : "DENIED "}  retry-after=${d.retryAfter}ms`,
      );
    }
    console.log(`strategy=${opts.strategy} rate=${opts.rate}/s capacity=${opts.capacity}`);
    console.log(rows.join("\n"));
    console.log(`\n${allowed}/${opts.count} allowed (${((allowed / opts.count) * 100).toFixed(1)}%)`);
  });

program
  .command("bench")
  .description("Benchmark throughput of a strategy under load.")
  .requiredOption("-r, --rate <n>", "operations per second", parseFloat)
  .option("-c, --capacity <n>", "burst capacity", parseFloat, 100)
  .option("-s, --strategy <name>", "token-bucket | leaky-bucket | fixed-window", parseStrategy, "token-bucket")
  .option("-n, --count <n>", "number of requests to run", parseFloat, 1000)
  .action(async (opts: { rate: number; capacity: number; strategy: StrategyName; count: number }) => {
    const limiter = new Limiter({ strategy: opts.strategy, rate: opts.rate, capacity: opts.capacity });
    const started = Date.now();
    let ok = 0;
    for (let i = 0; i < opts.count; i++) {
      const r = await limiter.run(async () => i);
      if (r.ok) ok += 1;
    }
    const elapsed = (Date.now() - started) / 1000;
    console.log(
      `strategy=${opts.strategy} rate=${opts.rate}/s capacity=${opts.capacity} count=${opts.count}`,
    );
    console.log(`completed ${ok}/${opts.count} in ${elapsed.toFixed(2)}s (${(ok / elapsed).toFixed(1)} ops/s)`);
  });

program
  .command("request")
  .description("Make a rate-limited request to the Terraform Cloud API.")
  .option("-t, --token <token>", "Terraform Cloud API token (or TFC_TOKEN env)")
  .option("-b, --base-url <url>", "API base URL", "https://app.terraform.io/api/v2")
  .option("-r, --rate <n>", "requests per second", parseFloat, 10)
  .argument("<path>", "API path, e.g. /organizations")
  .action(async (path: string, opts: { token?: string; baseUrl: string; rate: number }) => {
    const token = opts.token ?? process.env.TFC_TOKEN;
    const client = new TerraformClient({ token, baseUrl: opts.baseUrl, rate: opts.rate });
    try {
      const res = await client.request("GET", path);
      console.log(`status=${res.status} strategy=${client.strategy}`);
      console.log(res.body.slice(0, 2000));
    } catch (err) {
      console.error(`request failed: ${err}`);
      process.exit(1);
    }
  });

if (import.meta.main) {
  program.parse(process.argv);
}
