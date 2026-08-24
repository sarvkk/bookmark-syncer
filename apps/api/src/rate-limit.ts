import type { MiddlewareHandler } from "hono";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Simple in-memory fixed-window rate limiter. Per isolate, so limits are
 * per Cloudflare PoP instance — sufficient as abuse mitigation, not a
 * hard guarantee. See docs/architecture.md.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyBy?: string;
}): MiddlewareHandler {
  return async (c, next) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "local";
    const key = `${options.keyBy ?? "*"}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }

    if (bucket.count > options.max) {
      c.header("retry-after", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return c.json({ error: "rate limited" }, 429);
    }

    await next();
  };
}
