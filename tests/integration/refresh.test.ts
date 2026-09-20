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
  JWT_SIGNING_SECRET: "refresh-integration-secret-32-bytes-plus!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

describe("Task 15a — refresh rotation + reuse detection (R3.3, R3.4)", async () => {
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
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
  });

  async function loginTokens() {
    await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { organizationName: "Refresh Co", email: "r@x.test", password: "password123" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "r@x.test", password: "password123" },
    });
    return res.json() as { access_token: string; refresh_token: string };
  }

  maybe("with a live app", () => {
    it("rotates: a valid refresh token yields new tokens (R3.3)", async () => {
      const t = await loginTokens();
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refresh_token: t.refresh_token },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.access_token).toBeTruthy();
      expect(body.refresh_token).toBeTruthy();
      expect(body.refresh_token).not.toBe(t.refresh_token); // rotated
    });

    it("reuse of a rotated token revokes the whole family (R3.4)", async () => {
      const t = await loginTokens();
      // First rotation — succeeds, returns t2.
      const r1 = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refresh_token: t.refresh_token },
      });
      const t2 = r1.json().refresh_token as string;

      // Wait beyond the overlap window, then reuse the ORIGINAL (now-used) token → theft signal.
      await new Promise((r) => setTimeout(r, 10_100));
      const reuse = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refresh_token: t.refresh_token },
      });
      expect(reuse.statusCode).toBe(401);

      // The family is now revoked, so even the previously-valid t2 is rejected.
      const afterRevoke = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refresh_token: t2 },
      });
      expect(afterRevoke.statusCode).toBe(401);
    });

    it("rejects an unknown refresh token with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refresh_token: "not-a-real-token" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
