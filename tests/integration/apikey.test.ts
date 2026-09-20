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
  JWT_SIGNING_SECRET: "apikey-integration-secret-32-bytes-plus!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
});

describe("R5 — API keys", async () => {
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
    it("create returns the plaintext key once; the key authenticates requests, tenant-scoped (R5.1, R5.2, R5.6)", async () => {
      const tokenA = await ownerToken("Key A", "keya@x.test");
      const tokenB = await ownerToken("Key B", "keyb@x.test");
      // A creates a project + an API key.
      await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { name: "A-proj" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { name: "ci" },
      });
      expect(created.statusCode).toBe(201);
      const apiKey = created.json().api_key as string;
      expect(apiKey.startsWith("tf_")).toBe(true);

      // B creates a project too.
      await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { name: "B-proj" },
      });

      // The API key authenticates and sees ONLY tenant A's data (R5.6 same RLS scope).
      const viaKey = await app.inject({
        method: "GET",
        url: "/v1/projects",
        headers: { "x-api-key": apiKey },
      });
      expect(viaKey.statusCode).toBe(200);
      const names = viaKey.json().data.map((p: { name: string }) => p.name);
      expect(names).toContain("A-proj");
      expect(names).not.toContain("B-proj");
    });

    it("revoked key is rejected with 401 (R5.3)", async () => {
      const token = await ownerToken("Key Rev", "keyrev@x.test");
      const created = await app.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "temp" },
      });
      const apiKey = created.json().api_key as string;
      const id = created.json().id as string;

      // Works before revoke.
      const ok = await app.inject({ method: "GET", url: "/v1/projects", headers: { "x-api-key": apiKey } });
      expect(ok.statusCode).toBe(200);

      // Revoke, then it's rejected.
      const del = await app.inject({
        method: "DELETE",
        url: `/v1/api-keys/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(204);
      const after = await app.inject({ method: "GET", url: "/v1/projects", headers: { "x-api-key": apiKey } });
      expect(after.statusCode).toBe(401);
    });

    it("a member cannot create an API key — RBAC hasMinRole (R4, R5.5)", async () => {
      const ownerTok = await ownerToken("Key RBAC", "keyrbac@x.test");
      const invite = await app.inject({
        method: "POST",
        url: "/v1/invitations",
        headers: { authorization: `Bearer ${ownerTok}` },
        payload: { email: "m@keyrbac.test", role: "member" },
      });
      await app.inject({
        method: "POST",
        url: "/v1/auth/invitations/accept",
        payload: { token: invite.json().invitation_token, password: "memberpass1" },
      });
      const memberLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "m@keyrbac.test", password: "memberpass1" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers: { authorization: `Bearer ${memberLogin.json().access_token}` },
        payload: { name: "nope" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
