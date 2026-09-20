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
  JWT_SIGNING_SECRET: "export-integration-secret-32-bytes-plus!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

describe("Task 24 — tenant data export (R24)", async () => {
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

  async function ownerToken(org: string, email: string) {
    await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { organizationName: org, email, password: "password123" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "password123" },
    });
    return login.json().access_token as string;
  }

  maybe("with a live app", () => {
    it("exports every tenant-scoped table, only the caller's rows, secrets excluded (R24)", async () => {
      const tokenA = await ownerToken("Export A", "exa@x.test");
      const tokenB = await ownerToken("Export B", "exb@x.test");
      // A creates a project; B creates a differently-named one.
      await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { name: "A-only" },
      });
      await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { name: "B-only" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/v1/exports",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(200);
      const archive = res.json();

      // Covers every registered tenant-scoped table (R24.2).
      for (const table of TENANT_SCOPED_TABLES) {
        expect(archive.tables).toHaveProperty(table);
      }

      // Only A's project (R24.3).
      const projectNames = archive.tables.projects.map((p: { name: string }) => p.name);
      expect(projectNames).toContain("A-only");
      expect(projectNames).not.toContain("B-only");

      // Secret columns excluded (R24.4): users rows must not carry password_hash.
      for (const u of archive.tables.users) {
        expect(u).not.toHaveProperty("password_hash");
        expect(u).toHaveProperty("email");
      }
    });

    it("rejects a member (403) — owner/admin only (R24.1)", async () => {
      const ownerTok = await ownerToken("Export C", "exc@x.test");
      // Invite a member and accept.
      const invite = await app.inject({
        method: "POST",
        url: "/v1/invitations",
        headers: { authorization: `Bearer ${ownerTok}` },
        payload: { email: "member@exc.test", role: "member" },
      });
      const inviteToken = invite.json().invitation_token as string;
      await app.inject({
        method: "POST",
        url: "/v1/auth/invitations/accept",
        payload: { token: inviteToken, password: "memberpass1" },
      });
      const memberLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "member@exc.test", password: "memberpass1" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/exports",
        headers: { authorization: `Bearer ${memberLogin.json().access_token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
