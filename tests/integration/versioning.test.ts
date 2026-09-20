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
  JWT_SIGNING_SECRET: "versioning-integration-secret-32-bytes!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

describe("Task 16 — API versioning: /v1 frozen, /v2 breaking change coexist (R13)", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let db: StartedDb;
  let ownerPool: Pool;
  let appPool: Pool;
  let app: FastifyInstance;
  let auth: { authorization: string };

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
    await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { organizationName: "Ver Co", email: "ver@x.test", password: "password123" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "ver@x.test", password: "password123" },
    });
    auth = { authorization: `Bearer ${login.json().access_token}` };
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth,
      payload: { name: "shared" },
    });
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
  });

  maybe("both versions live", () => {
    it("/v1 keeps the frozen contract: { data, next_cursor } with created_at (R13.2)", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/projects", headers: auth });
      const body = res.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("next_cursor");
      expect(body).not.toHaveProperty("items");
      expect(body.data[0]).toHaveProperty("created_at");
      expect(body.data[0]).not.toHaveProperty("createdAt");
    });

    it("/v2 has the breaking contract: { items, page } with createdAt (R13.2)", async () => {
      const res = await app.inject({ method: "GET", url: "/v2/projects", headers: auth });
      const body = res.json();
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("page");
      expect(body).not.toHaveProperty("data");
      expect(body.items[0]).toHaveProperty("createdAt");
      expect(body.items[0]).not.toHaveProperty("created_at");
    });

    it("both versions serve the same tenant's data concurrently (R13.3)", async () => {
      const v1 = await app.inject({ method: "GET", url: "/v1/projects", headers: auth });
      const v2 = await app.inject({ method: "GET", url: "/v2/projects", headers: auth });
      expect(v1.json().data[0].name).toBe("shared");
      expect(v2.json().items[0].name).toBe("shared");
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
