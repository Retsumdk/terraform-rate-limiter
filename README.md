# terraform-rate-limiter

Rate-limit **Terraform Cloud / Enterprise API requests** and **arbitrary shell commands** with battle-tested token-bucket, leaky-bucket, and fixed-window strategies — including automatic retry with exponential backoff on `429` responses.

Terraform Cloud enforces strict API rate limits (and provider APIs do too). When you exceed them you get `429 Too Many Requests`, and naive retry loops just hammer the wall again. This tool sits in front of those calls, throttles you **before** you hit the limit, and backs off cleanly when you do.

## Problem

- Terraform Cloud's API rate-limits requests per organization and per IP.
- Provider APIs (AWS, GCP, Azure, etc.) return `429` when you exceed their quotas.
- Scripts that run `terraform plan`/`apply` in a loop, or CI pipelines that fan out, blow through these limits.
- A naive `sleep` on `429` is fragile: it doesn't respect the `Retry-After` header or the `X-RateLimit-*` headers, and it can't smooth out bursts.

## Solution

`terraform-rate-limiter` gives you three composable pieces:

1. **Rate-limit algorithms** (`src/rate-limiter.ts`) — correct, tested implementations of token bucket, leaky bucket, and fixed window.
2. **A `Limiter` wrapper** (`src/limiter.ts`) — runs any async task under a rate limit and retries with exponential backoff + jitter when it raises a `RateLimitError`.
3. **A Terraform-aware client** (`src/terraform.ts`) — a small TFC API client that reads `X-RateLimit-Remaining`/`X-RateLimit-Reset` headers to self-throttle *before* hitting the wall, and retries on `429`.

## How it works

- **Token bucket**: tokens refill at `rate`/sec up to `capacity`. Allows short bursts up to `capacity` while enforcing a long-run average of `rate` ops/sec.
- **Leaky bucket**: a queue of depth `capacity` that drains at `rate` items/sec. Perfectly smooth output, but rejects bursts.
- **Fixed window**: counts requests per 1-second window. Simple and predictable; allows up to 2× `rate` around window boundaries.
- **Retry/backoff**: on `429` (or a `RateLimitError`), the `Limiter` waits `Retry-After` if present, otherwise backs off exponentially with jitter, up to `maxRetries`.

## Getting started

Requires [Bun](https://bun.sh) (≥ 1.0).

```bash
git clone https://github.com/Retsumdk/terraform-rate-limiter.git
cd terraform-rate-limiter
bun install
```

Run the test suite:

```bash
bun test
```

Type-check:

```bash
bun run build
```

## Usage

**Wrap a shell command under a rate limit** (e.g. a loop of `terraform plan`):

```bash
bun run src/index.ts run -r 5 "terraform plan"
```

**Simulate a rate-limit config and see each decision:**

```bash
bun run src/index.ts limit -r 5 -c 10 -n 25
```

Example output:

```
strategy=token-bucket rate=5/s capacity=10
    1  ALLOWED  retry-after=0ms
    2  ALLOWED  retry-after=0ms
    ...
   11  DENIED   retry-after=200ms
   12  DENIED   retry-after=200ms

10/15 allowed (66.7%)
```

**Benchmark a strategy under load:**

```bash
bun run src/index.ts bench -r 100 -c 200 -n 1000
```

**Make a rate-limited request to the Terraform Cloud API:**

```bash
export TFC_TOKEN=your-token
bun run src/index.ts request -r 10 /organizations
```

## API

```ts
import { createLimiter } from "./src/rate-limiter.ts";
import { Limiter } from "./src/limiter.ts";
import { TerraformClient } from "./src/terraform.ts";

// Direct algorithm use
const bucket = createLimiter("token-bucket", { rate: 10, capacity: 20 });
const decision = bucket.tryAcquire(); // { allowed, retryAfter }

// Run a task under a limit with retry/backoff
const limiter = new Limiter({ strategy: "token-bucket", rate: 10, capacity: 20 });
const result = await limiter.run(async () => { /* do work */ });
// result.ok, result.value, result.retries

// Rate-limited Terraform Cloud client
const client = new TerraformClient({ token: process.env.TFC_TOKEN, rate: 10 });
const res = await client.request("GET", "/organizations");
```

## Configuration

All commands accept `--rate` (ops/sec) and `--capacity` (burst). The `request`
command reads `TFC_TOKEN` from the environment or via `--token`, and accepts
`--base-url` to point at Terraform Enterprise or a provider API.

## License

MIT License — see [LICENSE](LICENSE).

---

Built by [Retsumdk](https://github.com/Retsumdk)
