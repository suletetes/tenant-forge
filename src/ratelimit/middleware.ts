import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors";
import type { RateLimiter, LimitResult } from "./limiter";
import { bucketForPlan, IP_BUCKETS } from "./plans";
import "../middleware/types";

function setHeaders(reply: FastifyReply, r: LimitResult): void {
  reply.header("X-RateLimit-Limit", String(r.limit));
  reply.header("X-RateLimit-Remaining", String(Math.max(0, r.remaining)));
  reply.header("X-RateLimit-Reset", String(Math.ceil(r.resetMs / 1000)));
}

function tooMany(retryAfterMs: number): AppError {
  const e = new AppError(429, "RATE_LIMITED", "Too Many Requests");
  // Attach Retry-After via a property the error handler / caller can read.
  (e as AppError & { retryAfterSec?: number }).retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return e;
}

/**
 * Per-tenant limiter (R12). Keyed by tenant_id, scaled by the caller's plan. Must run AFTER auth
 * so req.auth is set. Sets X-RateLimit-* headers; 429 + Retry-After when the bucket is empty.
 *
 * Fail policy (R12.6, design §6.4): if Redis is unavailable, fail-CLOSED (503) on mutating/auth
 * routes, fail-OPEN on idempotent GETs. Emits a degraded metric via the logger.
 */
export function makeTenantRateLimiter(limiter: RateLimiter, planOf: (tenantId: string) => Promise<string>) {
  return async function tenantRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return; // unauthenticated routes use the IP limiter instead
    try {
      const plan = await planOf(tenantId);
      const result = await limiter.consume(`ratelimit:${tenantId}`, bucketForPlan(plan));
      setHeaders(reply, result);
      if (!result.allowed) {
        reply.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
        throw tooMany(result.retryAfterMs);
      }
    } catch (err) {
      if (err instanceof AppError) throw err; // the 429
      req.log.error({ err, metric: "ratelimiter_degraded" }, "rate limiter unavailable");
      const isRead = req.method === "GET" || req.method === "HEAD";
      if (!isRead) throw new AppError(503, "INTERNAL", "Service temporarily unavailable");
      // fail-open on reads
    }
  };
}

/**
 * Pre-auth / IP limiter (R23). Keyed by trusted-proxy client IP + route class. Stricter on
 * credential routes.
 */
export function makeIpRateLimiter(
  limiter: RateLimiter,
  routeClass: "credential" | "general",
) {
  return async function ipRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ip = req.ip; // Fastify derives this from the trusted proxy (trustProxy) — R23.5
    const cfg = IP_BUCKETS[routeClass];
    try {
      const result = await limiter.consume(`ratelimit:ip:${ip}:${routeClass}`, cfg);
      setHeaders(reply, result);
      if (!result.allowed) {
        reply.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
        throw tooMany(result.retryAfterMs);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Credential endpoints fail closed; general pre-auth fails open.
      req.log.error({ err, metric: "ratelimiter_degraded" }, "ip rate limiter unavailable");
      if (routeClass === "credential") {
        throw new AppError(503, "INTERNAL", "Service temporarily unavailable");
      }
    }
  };
}
