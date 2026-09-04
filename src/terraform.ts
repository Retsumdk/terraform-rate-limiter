/**
 * terraform.ts
 *
 * A minimal Terraform Cloud / Enterprise API client that is rate-limit aware.
 *
 * The Terraform Cloud API (and most provider APIs) enforce rate limits via the
 * `X-RateLimit-*` response headers and return HTTP 429 when a limit is hit.
 * This client:
 *
 *  1. Reads `X-RateLimit-Remaining` / `X-RateLimit-Reset` and feeds them into a
 *     `Limiter` so the client self-throttles *before* hitting the wall.
 *  2. Retries with exponential backoff when it still receives a 429.
 *
 * It is intentionally small and dependency-free; the real value is the
 * rate-limit integration, which is what this repository demonstrates.
 */

import { Limiter, RateLimitError } from "./limiter.ts";

export interface TerraformClientConfig {
  /** Terraform Cloud API base URL. Defaults to the public TFC API. */
  baseUrl?: string;
  /** Bearer token for the Terraform Cloud API (or provider API). */
  token?: string;
  /** Requests per second the upstream allows. */
  rate?: number;
  /** Burst capacity. */
  capacity?: number;
  /** Maximum retries on 429. */
  maxRetries?: number;
}

export interface TerraformApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class TerraformClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly limiter: Limiter;

  constructor(cfg: TerraformClientConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? "https://app.terraform.io/api/v2").replace(/\/$/, "");
    this.token = cfg.token;
    this.limiter = new Limiter({
      strategy: "token-bucket",
      rate: cfg.rate ?? 10,
      capacity: cfg.capacity ?? 20,
      maxRetries: cfg.maxRetries ?? 3,
    });
  }

  /** Perform a rate-limited request against the Terraform API. */
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<TerraformApiResponse> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const result = await this.limiter.run<TerraformApiResponse>(async () => {
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;

      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      // Respect upstream rate-limit headers if present.
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (remaining === "0" && reset) {
        const waitMs = Math.max(0, Number(reset) * 1000 - Date.now());
        throw new RateLimitError(waitMs);
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
        throw new RateLimitError(retryAfter);
      }

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: res.status,
        headers: responseHeaders,
        body: await res.text(),
      };
    });

    if (!result.ok) {
      throw result.error;
    }
    return result.value as TerraformApiResponse;
  }

  /** Convenience: GET a resource and parse JSON. */
  async getJson<T>(path: string): Promise<T> {
    const res = await this.request("GET", path);
    if (res.status >= 400) {
      throw new Error(`GET ${path} failed with status ${res.status}: ${res.body}`);
    }
    return JSON.parse(res.body) as T;
  }

  get strategy(): string {
    return this.limiter.strategy;
  }
}
