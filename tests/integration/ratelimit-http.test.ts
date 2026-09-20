import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import type { AppConfig } from "../../src/config";
import { runMigrations } from "../../src/db/migrate";
import { RateLimiter } from "../../src/ratelimit/limiter";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";
import { startRedis, type StartedRedis } from "./helpers/redis";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

const cfg = (dbUrl: string, migUrl: string): AppConfig => ({
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "silent" as AppConfig["LOG_LEVEL"],
  DATABASE_URL: dbUrl,
  MIGRATION_DATABASE_URL: migUrl,
  JWT_SIGNING_SECRET: "ratelimit-http-secret-at-least-32-bytes!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

describe("Task 14 — rate limiting through the app (R12.3, R12.4)", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let db: StartedDb;
  let redis: StartedRedis;
  let ownerPool: Pool;
  let appPool: Pool;
  let redisClient: Redis;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!hasDocker) return;
    db = await startPostgres();
    redis = await startRedis();
    await runMigrations({
      migrationUrl: db.migrationUrl,
      appRole: APP_ROLE,
      appPassword: APP_PW,
      migrationsFolder: "./drizzle",
    });
    ownerPool = new Pool({ connectionString: db.migrationUrl, max: 3 });
    appPool = new Pool({ connectionString: db.appUrl(APP_ROLE, APP_PW), max: 5 });
    redisClient = new Redis(redis.url);
    app = buildApp(cfg(db.appUrl(APP_ROLE, APP_PW), db.migrationUrl), {
      ownerPool,
      appPool,
      rateLimiter: new RateLimiter(redisClient),
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await app?.close();
    redisClient?.disconnect();
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
    await redis?.stop();
  });

  maybe("with a live app + Redis", () => {
    it("returns X-RateLimit headers and 429 with Retry-After once the free bucket drains (R12.3, R12.4)", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { organizationName: "RL Co", email: "rl@x.test", password: "password123" },
      });
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "rl@x.test", password: "password123" },
      });
      const auth = { authorization: `Bearer ${login.json().access_token}` };

      // free plan = capacity 60. Fire GETs until 429; headers must appear on allowed responses.
      let sawHeaders = false;
      let limited = false;
      let retryAfter: string | undefined;
      for (let i = 0; i < 65; i++) {
        const res = await app.inject({ method: "GET", url: "/v1/projects", headers: auth });
        if (res.headers["x-ratelimit-limit"]) sawHeaders = true;
        if (res.statusCode === 429) {
          limited = true;
          retryAfter = res.headers["retry-after"] as string;
          break;
        }
      }
      expect(sawHeaders).toBe(true);
      expect(limited).toBe(true);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(0);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
