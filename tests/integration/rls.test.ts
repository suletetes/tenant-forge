import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate";
import { TENANT_SCOPED_TABLES } from "../../src/db/schema/index";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

describe("Task 2 — RLS migrations + roles (R6.1, R6.2, R6.3, R18.2)", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let db: StartedDb;
  let ownerPool: Pool;

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
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await ownerPool?.end();
    await db?.stop();
  });

  maybe("with a live Postgres", () => {
    it("enables and FORCEs RLS on every tenant-scoped table (R6.2)", async () => {
      const { rows } = await ownerPool.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY($1)`,
        [[...TENANT_SCOPED_TABLES]],
      );
      expect(rows.length).toBe(TENANT_SCOPED_TABLES.length);
      for (const r of rows) {
        expect(r.relrowsecurity, `${r.relname} RLS enabled`).toBe(true);
        expect(r.relforcerowsecurity, `${r.relname} RLS forced`).toBe(true);
      }
    });

    it("the app role is NOT superuser and does NOT have BYPASSRLS (R6.3)", async () => {
      const { rows } = await ownerPool.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
        [APP_ROLE],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolsuper).toBe(false);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("tenant-scoped tables have a tenant_id NOT NULL column (R6.1)", async () => {
      const { rows } = await ownerPool.query(
        `SELECT table_name, is_nullable FROM information_schema.columns
         WHERE column_name = 'tenant_id' AND table_name = ANY($1)`,
        [[...TENANT_SCOPED_TABLES]],
      );
      expect(rows.length).toBe(TENANT_SCOPED_TABLES.length);
      for (const r of rows) expect(r.is_nullable).toBe("NO");
    });

    it("an app-role query without tenant context returns zero rows (fail-closed, R6.8)", async () => {
      const appPool = new Pool({ connectionString: db.appUrl(APP_ROLE, APP_PW), max: 1 });
      try {
        // Seed a row via the owner (bypasses RLS as table owner? No — FORCE applies; owner sets GUC).
        const org = await ownerPool.query(
          `INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
        );
        const tenantId = org.rows[0].id;
        await ownerPool.query(`SELECT set_config('app.current_tenant_id',$1,false)`, [tenantId]);
        await ownerPool.query(
          `INSERT INTO projects (tenant_id, name) VALUES ($1,'p1')`,
          [tenantId],
        );

        // App role, NO tenant context set → RLS filters everything out.
        const res = await appPool.query(`SELECT * FROM projects`);
        expect(res.rowCount).toBe(0);
      } finally {
        await appPool.end();
      }
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
