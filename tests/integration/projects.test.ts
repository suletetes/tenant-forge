import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import type { AppConfig } from "../../src/config";
import { runMigrations } from "../../src/db/migrate";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

const baseConfig = (dbUrl: string, migUrl: string): AppConfig => ({
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "silent" as AppConfig["LOG_LEVEL"],
  DATABASE_URL: dbUrl,
  MIGRATION_DATABASE_URL: migUrl,
  JWT_SIGNING_SECRET: "integration-secret-at-least-32-bytes-long!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

async function signupAndLogin(app: FastifyInstance, org: string, email: string) {
  await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { organizationName: org, email, password: "password123" },
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "password123" },
  });
  return res.json().access_token as string;
}

describe("Task 6 — projects CRUD + isolation (R8)", async () => {
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
    app = buildApp(baseConfig(db.appUrl(APP_ROLE, APP_PW), db.migrationUrl), {
      ownerPool,
      appPool,
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
  });

  maybe("with a live app", () => {
    it("creates, reads, lists, updates, and deletes a project", async () => {
      const token = await signupAndLogin(app, "Crud Co", "crud@x.test");
      const auth = { authorization: `Bearer ${token}` };

      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: auth,
        payload: { name: "First" },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;

      const got = await app.inject({ method: "GET", url: `/v1/projects/${id}`, headers: auth });
      expect(got.statusCode).toBe(200);
      expect(got.json().name).toBe("First");

      const list = await app.inject({ method: "GET", url: "/v1/projects", headers: auth });
      expect(list.json().data).toHaveLength(1);

      const patched = await app.inject({
        method: "PATCH",
        url: `/v1/projects/${id}`,
        headers: auth,
        payload: { name: "Renamed" },
      });
      expect(patched.json().name).toBe("Renamed");

      const del = await app.inject({ method: "DELETE", url: `/v1/projects/${id}`, headers: auth });
      expect(del.statusCode).toBe(204);
    });

    it("ignores a body-supplied tenant_id, stamping from the token (R8.2)", async () => {
      const token = await signupAndLogin(app, "Stamp Co", "stamp@x.test");
      const auth = { authorization: `Bearer ${token}` };
      const res = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: auth,
        payload: { name: "Stamped", tenant_id: "00000000-0000-0000-0000-000000000000" },
      });
      expect(res.statusCode).toBe(201);
      // The project belongs to the caller's tenant, not the injected one → it is listable.
      const list = await app.inject({ method: "GET", url: "/v1/projects", headers: auth });
      expect(list.json().data.map((p: { name: string }) => p.name)).toContain("Stamped");
    });

    it("returns 404 for a project owned by another tenant (R8.6)", async () => {
      const tokenA = await signupAndLogin(app, "Tenant A", "a@x.test");
      const tokenB = await signupAndLogin(app, "Tenant B", "b@x.test");
      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { name: "A-owned" },
      });
      const id = created.json().id as string;
      const cross = await app.inject({
        method: "GET",
        url: `/v1/projects/${id}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(cross.statusCode).toBe(404);
    });

    it("rejects unauthenticated requests with 401", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/projects" });
      expect(res.statusCode).toBe(401);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
