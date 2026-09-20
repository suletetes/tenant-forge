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
  JWT_SIGNING_SECRET: "enforcement-integration-secret-32-bytes!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

describe("Task 15b — plan enforcement live (R11.1, R21)", async () => {
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

  async function newTenant(org: string, email: string) {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { organizationName: org, email, password: "password123" },
    });
    const tenantId = signup.json().organization_id as string;
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "password123" },
    });
    return { tenantId, token: login.json().access_token as string };
  }

  maybe("with a live app", () => {
    it("free plan blocks the 4th active project with 403 QUOTA_EXCEEDED (R21)", async () => {
      const { token } = await newTenant("Quota Co", "quota@x.test");
      const auth = { authorization: `Bearer ${token}` };
      for (let i = 1; i <= 3; i++) {
        const ok = await app.inject({
          method: "POST",
          url: "/v1/projects",
          headers: auth,
          payload: { name: `p${i}` },
        });
        expect(ok.statusCode).toBe(201);
      }
      const over = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: auth,
        payload: { name: "p4" },
      });
      expect(over.statusCode).toBe(403);
      expect(over.json().error.code).toBe("QUOTA_EXCEEDED");
    });

    it("past_due tenant: reads OK, writes 402 (R11.1)", async () => {
      const { tenantId, token } = await newTenant("PastDue Co", "pastdue@x.test");
      const auth = { authorization: `Bearer ${token}` };
      // Create a project while active.
      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: auth,
        payload: { name: "before" },
      });
      expect(created.statusCode).toBe(201);

      // Flip the tenant to past_due via a subscription row.
      await ownerPool.query(`SELECT set_config('app.current_tenant_id',$1,false)`, [tenantId]);
      await ownerPool.query(
        `INSERT INTO subscriptions (tenant_id, status, plan) VALUES ($1,'past_due','starter')`,
        [tenantId],
      );
      await ownerPool.query(`RESET app.current_tenant_id`);

      // Read still works.
      const read = await app.inject({ method: "GET", url: "/v1/projects", headers: auth });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.length).toBeGreaterThanOrEqual(1);

      // Write is blocked with 402.
      const write = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: auth,
        payload: { name: "after" },
      });
      expect(write.statusCode).toBe(402);
      expect(write.json().error.code).toBe("PAYMENT_REQUIRED");
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
