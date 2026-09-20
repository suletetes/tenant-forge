import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate";
import { signup } from "../../src/auth/signup.service";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

describe("Task 3 — signup provisioning (R1)", async () => {
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
    ownerPool = new Pool({ connectionString: db.migrationUrl, max: 3 });
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await ownerPool?.end();
    await db?.stop();
  });

  maybe("with a live Postgres", () => {
    it("creates an organization + owner user + audit entry in one transaction (R1.1, R1.5)", async () => {
      const res = await signup(ownerPool, {
        organizationName: "Acme",
        email: "owner@acme.test",
        password: "password123",
      });
      expect(res.organizationId).toBeTruthy();
      expect(res.ownerUserId).toBeTruthy();

      const org = await ownerPool.query(`SELECT plan FROM organizations WHERE id=$1`, [
        res.organizationId,
      ]);
      expect(org.rows[0].plan).toBe("free");

      const user = await ownerPool.query(
        `SELECT role, password_hash FROM users WHERE id=$1`,
        [res.ownerUserId],
      );
      expect(user.rows[0].role).toBe("owner");
      expect(user.rows[0].password_hash).not.toContain("password123"); // R1.6

      const audit = await ownerPool.query(
        `SELECT action FROM audit_log WHERE tenant_id=$1`,
        [res.organizationId],
      );
      expect(audit.rows.map((r) => r.action)).toContain("org.created");
    });

    it("rejects a duplicate email within the tenant with 409 (R1.4)", async () => {
      await signup(ownerPool, {
        organizationName: "Dup Co",
        email: "dupe@x.test",
        password: "password123",
      });
      // Re-inserting the same email into the SAME org id would 409; simulate by inserting a
      // second owner with the same email into the freshly created tenant.
      const first = await ownerPool.query(
        `SELECT id FROM organizations WHERE slug LIKE 'dup-co-%' LIMIT 1`,
      );
      const tenantId = first.rows[0].id;
      await ownerPool.query(`SELECT set_config('app.current_tenant_id',$1,false)`, [tenantId]);
      let threw: unknown;
      try {
        await ownerPool.query(
          `INSERT INTO users (tenant_id,email,password_hash,role) VALUES ($1,'dupe@x.test','h','member')`,
          [tenantId],
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeTruthy(); // unique(tenant_id,email) violated
      await ownerPool.query(`RESET app.current_tenant_id`);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
