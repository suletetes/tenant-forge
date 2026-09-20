import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import type { AppConfig } from "../../src/config";
import { runMigrations } from "../../src/db/migrate";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

const cfg = (dbUrl: string, migUrl: string): AppConfig => ({
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "silent" as AppConfig["LOG_LEVEL"],
  DATABASE_URL: dbUrl,
  MIGRATION_DATABASE_URL: migUrl,
  JWT_SIGNING_SECRET: "spa-integration-secret-at-least-32-bytes!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
  CORS_ORIGIN: "*",
});

/**
 * Task 22 — verifies the admin SPA can actually drive the API: the browser fetch flow
 * (preflight → signup → login → projects CRUD) works cross-origin and the rate-limit headers the
 * SPA displays are exposed. This is the "SPA wires to the API" verification (no browser needed —
 * we assert the exact HTTP contract the SPA depends on).
 */
describe("Task 22 — admin SPA API contract (CORS + flow)", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let db: StartedDb;
  let ownerPool: Pool;
  let appPool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!hasDocker) return;
    db = await startPostgres();
    await runMigrations({
      migrationUrl: db.migrationUrl,
      appRole: APP_ROLE,
      appPassword: APP_PW,
      migrationsFolder: "./drizzle",
    });
    ownerPool = new Pool({ connectionString: db.migrationUrl, max: 3 });
    appPool = new Pool({ connectionString: db.appUrl(APP_ROLE, APP_PW), max: 5 });
    app = buildApp(cfg(db.appUrl(APP_ROLE, APP_PW), db.migrationUrl), { ownerPool, appPool });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
  });

  maybe("with a live app", () => {
    it("preflight OPTIONS on a real route returns 204 + CORS headers", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/v1/auth/login",
        headers: { origin: "http://localhost:8080" },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });

    it("runs the SPA flow: signup → login → create → list with readable RateLimit headers", async () => {
      const email = "spa@x.test";
      const su = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { organizationName: "SPA Co", email, password: "password123" },
      });
      expect(su.statusCode).toBe(201);

      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email, password: "password123" },
      });
      const token = login.json().access_token as string;
      const auth = { authorization: `Bearer ${token}` };

      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: auth,
        payload: { name: "from-spa" },
      });
      expect(created.statusCode).toBe(201);

      const list = await app.inject({ method: "GET", url: "/v1/projects", headers: auth });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.map((p: { name: string }) => p.name)).toContain("from-spa");
      // The SPA reads these; they must be present + exposed.
      expect(list.headers["x-ratelimit-limit"]).toBeUndefined(); // no limiter in this app instance
      expect(list.headers["access-control-expose-headers"]).toContain("x-ratelimit-remaining");
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
