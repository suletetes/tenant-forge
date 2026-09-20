import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

export interface StartedRedis {
  /** Connection URL, including a per-suite logical DB index when sharing the global Redis. */
  url: string;
  stop: () => Promise<unknown>;
}

// Redis has 16 logical DBs (0-15). Hand each suite a distinct one so keys don't collide while
// sharing a single container. Wraps around if there are more suites than DBs (acceptable — the
// suites that use Redis are few, and keys are still uniquely prefixed by the limiter).
let nextDbIndex = 1;

/**
 * Returns a Redis connection for a suite.
 *
 * Fast path (shared server from globalSetup): reuse the shared Redis on a distinct logical DB;
 * stop() flushes that DB rather than tearing down the container.
 *
 * Fallback (no shared server): start a dedicated container (original behavior).
 */
export async function startRedis(): Promise<StartedRedis> {
  const shared = process.env.TF_TEST_REDIS_URL;
  if (shared) {
    const dbIndex = nextDbIndex++ % 16 || 1;
    const base = shared.replace(/\/$/, "");
    const url = `${base}/${dbIndex}`;
    return {
      url,
      stop: async () => {
        const { Redis } = await import("ioredis");
        const c = new Redis(url);
        await c.flushdb();
        c.disconnect();
      },
    };
  }

  const container: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  return {
    url: container.getConnectionUrl(),
    stop: () => container.stop(),
  };
}
