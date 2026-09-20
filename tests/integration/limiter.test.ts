import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { RateLimiter } from "../../src/ratelimit/limiter";
import { dockerAvailable } from "./helpers/postgres";
import { startRedis, type StartedRedis } from "./helpers/redis";

describe("Task 14 — atomic token-bucket limiter (R12.2, R12.5)", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let redis: StartedRedis;
  let client: Redis;
  let client2: Redis;

  beforeAll(async () => {
    if (!hasDocker) return;
    redis = await startRedis();
    client = new Redis(redis.url);
    client2 = new Redis(redis.url);
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    client?.disconnect();
    client2?.disconnect();
    await redis?.stop();
  });

  maybe("with a live Redis", () => {
    it("allows up to capacity then denies with a retry-after (R12.4)", async () => {
      const limiter = new RateLimiter(client);
      const key = `t:${Date.now()}`;
      const cfg = { capacity: 5, refillPerSec: 0.001 }; // effectively no refill during test
      const results = [];
      for (let i = 0; i < 6; i++) results.push(await limiter.consume(key, cfg));
      expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
      expect(results[5]!.allowed).toBe(false);
      expect(results[5]!.retryAfterMs).toBeGreaterThan(0);
      expect(results[0]!.limit).toBe(5);
      expect(results[0]!.remaining).toBe(4);
    });

    it("refills over time (R12 refill math)", async () => {
      const limiter = new RateLimiter(client);
      const key = `refill:${Date.now()}`;
      const cfg = { capacity: 2, refillPerSec: 20 }; // 1 token per 50ms
      await limiter.consume(key, cfg);
      await limiter.consume(key, cfg); // bucket now empty
      const denied = await limiter.consume(key, cfg);
      expect(denied.allowed).toBe(false);
      // Wait well beyond one refill interval (250ms → ~5 tokens, capped at capacity 2).
      await new Promise((r) => setTimeout(r, 250));
      const afterRefill = await limiter.consume(key, cfg);
      expect(afterRefill.allowed).toBe(true);
    });

    it("holds the limit across TWO limiter instances — no per-instance overcount (R12.5)", async () => {
      const a = new RateLimiter(client);
      const b = new RateLimiter(client2);
      const key = `shared:${Date.now()}`;
      const cfg = { capacity: 4, refillPerSec: 0.001 };
      // Interleave 6 requests across the two instances; only 4 may pass total.
      const outcomes = [];
      for (let i = 0; i < 6; i++) {
        const limiter = i % 2 === 0 ? a : b;
        outcomes.push((await limiter.consume(key, cfg)).allowed);
      }
      expect(outcomes.filter(Boolean).length).toBe(4);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
