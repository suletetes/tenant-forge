import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import type { AppConfig } from "../../src/config";
import { runMigrations } from "../../src/db/migrate";
import { TENANT_SCOPED_TABLES } from "../../src/db/schema/index";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

const cfg = (dbUrl: string, migUrl: string): AppConfig => ({
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "silent" as AppConfig["LOG_LEVEL"],
  DATABASE_URL: dbUrl,
  MIGRATION_DATABASE_URL: migUrl,
  JWT_SIGNING_SECRET: "isolation-suite-secret-at-least-32-bytes!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

interface Tenant {
  token: string;
  tenantId: string;
  projectId: string;
}

/**
 * TASK 7 — SIGNATURE DELIVERABLE: cross-tenant isolation suite over THREE tenants.
 * Proves zero leakage across every access path (R6.6, R6.7):
 *   1. API: tenant A cannot read/patch/delete tenant B's project (404).
 *   2. Raw SQL on the app connection: with A's context, B's rows are invisible.
 *   3. Write attempt: inserting a row stamped with another tenant's id is blocked (WITH CHECK).
 *   4. Fail-closed: no tenant context → zero rows.
 * Plus a registry-drift lint: every tenant-scoped table must have an RLS policy.
 */
describe("Task 7 — cross-tenant isolation suite (R6.6, R6.7) [SIGNATURE]", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let db: StartedDb;
  let ownerPool: Pool;
  let appPool: Pool;
  let app: FastifyInstance;
  const tenants: Record<"A" | "B" | "C", Tenant> = {} as never;

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

    // Provision three tenants, each with one project, via the real API.
    for (const key of ["A", "B", "C"] as const) {
      const email = `owner-${key}@iso.test`;
      const signupRes = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { organizationName: `Tenant ${key}`, email, password: "password123" },
      });
      const tenantId = signupRes.json().organization_id as string;
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email, password: "password123" },
      });
      if (login.statusCode !== 200) {
        throw new Error(`login failed for ${key}: ${login.statusCode} ${login.body}`);
      }
      const token = login.json().access_token as string;
      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `${key}-secret` },
      });
      tenants[key] = {
        token,
        tenantId,
        projectId: created.json().id as string,
      };
    }
  }, 180_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
  });

  maybe("across three tenants", () => {
    it("API: each tenant lists ONLY its own project (R6.6)", async () => {
      for (const key of ["A", "B", "C"] as const) {
        const res = await app.inject({
          method: "GET",
          url: "/v1/projects",
          headers: { authorization: `Bearer ${tenants[key].token}` },
        });
        const names = res.json().data.map((p: { name: string }) => p.name);
        expect(names).toEqual([`${key}-secret`]);
      }
    });

    it("API: cross-tenant GET/PATCH/DELETE of a foreign project all 404 (R6.6)", async () => {
      const a = tenants.A;
      const bProject = tenants.B.projectId;
      const authA = { authorization: `Bearer ${a.token}` };
      expect((await app.inject({ method: "GET", url: `/v1/projects/${bProject}`, headers: authA })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: "PATCH", url: `/v1/projects/${bProject}`, headers: authA, payload: { name: "hijack" } })).statusCode,
      ).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/v1/projects/${bProject}`, headers: authA })).statusCode).toBe(404);
    });

    it("RAW SQL on the app connection: A's context cannot see B's or C's rows (R6.6)", async () => {
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenants.A.tenantId]);
        const all = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM projects`);
        // Every visible row belongs to A only.
        expect(all.rows.every((r) => r.tenant_id === tenants.A.tenantId)).toBe(true);
        expect(all.rows.length).toBe(1);
        await client.query("COMMIT");
        await client.query("RESET app.current_tenant_id");
      } finally {
        client.release();
      }
    });

    it("WRITE attempt: inserting a row with another tenant's id is blocked by WITH CHECK (R6.7)", async () => {
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenants.A.tenantId]);
        let threw: unknown;
        try {
          // A tries to plant a row owned by B → RLS WITH CHECK must reject.
          await client.query(`INSERT INTO projects (tenant_id, name) VALUES ($1,'planted')`, [
            tenants.B.tenantId,
          ]);
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeTruthy();
        await client.query("ROLLBACK");
        await client.query("RESET app.current_tenant_id");
      } finally {
        client.release();
      }
    });

    it("FAIL-CLOSED: no tenant context → zero rows (R6.8)", async () => {
      const client = await appPool.connect();
      try {
        const res = await client.query(`SELECT * FROM projects`);
        expect(res.rowCount).toBe(0);
      } finally {
        client.release();
      }
    });

    it("REGISTRY LINT: every tenant-scoped table has an RLS policy", async () => {
      const { rows } = await ownerPool.query<{ tablename: string }>(
        `SELECT DISTINCT tablename FROM pg_policies WHERE schemaname='public'`,
      );
      const withPolicy = new Set(rows.map((r) => r.tablename));
      for (const table of TENANT_SCOPED_TABLES) {
        expect(withPolicy.has(table), `${table} must have an RLS policy`).toBe(true);
      }
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
