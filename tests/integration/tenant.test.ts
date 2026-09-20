import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

/**
 * Simulates the withTenant transaction-local binding directly against the app pool to prove
 * the two hard properties (design §5): (1) no tenant bleed when a pooled connection is reused,
 * (2) fail-closed (zero rows) when no tenant context is set.
 */
describe("Task 5 — tenant-context binding (R6.4, R6.8, R6.9)", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let db: StartedDb;
  let ownerPool: Pool;
  let appPool: Pool;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    if (!hasDocker) return;
    db = await startPostgres();
    await runMigrations({
      migrationUrl: db.migrationUrl,
      appRole: APP_ROLE,
      appPassword: APP_PW,
      migrationsFolder: "./drizzle",
    });
    ownerPool = new Pool({ connectionString: db.migrationUrl, max: 2 });
    // max:1 forces the SAME physical connection to be reused → exposes any context bleed.
    appPool = new Pool({ connectionString: db.appUrl(APP_ROLE, APP_PW), max: 1 });

    const a = await ownerPool.query(`INSERT INTO organizations (name,slug) VALUES ('A','a') RETURNING id`);
    const b = await ownerPool.query(`INSERT INTO organizations (name,slug) VALUES ('B','b') RETURNING id`);
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;
    for (const [t, n] of [[tenantA, "a-proj"], [tenantB, "b-proj"]] as const) {
      await ownerPool.query(`SELECT set_config('app.current_tenant_id',$1,false)`, [t]);
      await ownerPool.query(`INSERT INTO projects (tenant_id,name) VALUES ($1,$2)`, [t, n]);
    }
    await ownerPool.query(`RESET app.current_tenant_id`);
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
  });

  /** Runs one "request" as a transaction-local tenant binding, returns visible project names. */
  async function requestAs(tenantId: string): Promise<string[]> {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantId]);
      const res = await client.query<{ name: string }>(`SELECT name FROM projects ORDER BY name`);
      await client.query("COMMIT");
      await client.query("RESET app.current_tenant_id");
      return res.rows.map((r) => r.name);
    } finally {
      client.release();
    }
  }

  maybe("with a live Postgres (max:1 pool → forced connection reuse)", () => {
    it("each tenant sees only its own rows — no bleed across reused connection (R6.9)", async () => {
      const a1 = await requestAs(tenantA);
      const b1 = await requestAs(tenantB); // reuses the same physical connection
      const a2 = await requestAs(tenantA);
      expect(a1).toEqual(["a-proj"]);
      expect(b1).toEqual(["b-proj"]);
      expect(a2).toEqual(["a-proj"]);
    });

    it("a query with NO tenant context returns zero rows (fail-closed, R6.8)", async () => {
      const client = await appPool.connect();
      try {
        // No set_config at all.
        const res = await client.query(`SELECT * FROM projects`);
        expect(res.rowCount).toBe(0);
      } finally {
        client.release();
      }
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
