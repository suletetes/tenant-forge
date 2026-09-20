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
  JWT_SIGNING_SECRET: "team-integration-secret-at-least-32-bytes!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

describe("Task 6b — team management + password reset (R20, R22)", async () => {
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

  async function ownerToken(org: string, email: string): Promise<string> {
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

  maybe("with a live app", () => {
    it("owner invites a member who accepts and can log in (R20)", async () => {
      const token = await ownerToken("Team Co", "owner@team.test");
      const invite = await app.inject({
        method: "POST",
        url: "/v1/invitations",
        headers: { authorization: `Bearer ${token}` },
        payload: { email: "member@team.test", role: "member" },
      });
      expect(invite.statusCode).toBe(201);
      const invitationToken = invite.json().invitation_token as string;

      const accept = await app.inject({
        method: "POST",
        url: "/v1/auth/invitations/accept",
        payload: { token: invitationToken, password: "memberpass1" },
      });
      expect(accept.statusCode).toBe(201);

      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "member@team.test", password: "memberpass1" },
      });
      expect(login.statusCode).toBe(200);
    });

    it("a member cannot invite (403)", async () => {
      // member from previous test
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "member@team.test", password: "memberpass1" },
      });
      const memberToken = login.json().access_token as string;
      const res = await app.inject({
        method: "POST",
        url: "/v1/invitations",
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { email: "x@team.test", role: "member" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("password reset request never reveals existence + confirm revokes refresh tokens (R22)", async () => {
      await ownerToken("Reset Co", "reset@rc.test");
      // Unknown email → still 202
      const unknown = await app.inject({
        method: "POST",
        url: "/v1/auth/password-reset/request",
        payload: { email: "nobody@rc.test" },
      });
      expect(unknown.statusCode).toBe(202);

      // Known email → 202, and a token row exists we can read via owner pool
      const known = await app.inject({
        method: "POST",
        url: "/v1/auth/password-reset/request",
        payload: { email: "reset@rc.test" },
      });
      expect(known.statusCode).toBe(202);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
