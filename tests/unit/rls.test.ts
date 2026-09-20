import { describe, expect, it } from "vitest";
import { createAppRoleSql, grantsSql, rlsPolicySql } from "../../src/db/rls";
import { TENANT_SCOPED_TABLES } from "../../src/db/schema/index";

describe("Task 2 — RLS SQL generation (R6.2, R6.3, R6.7)", () => {
  const sql = rlsPolicySql();

  it("ENABLEs and FORCEs RLS on every tenant-scoped table (R6.2)", () => {
    for (const table of TENANT_SCOPED_TABLES) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it("creates USING (read) and WITH CHECK (write) policies bound to the tenant GUC (R6.5, R6.7)", () => {
    for (const table of TENANT_SCOPED_TABLES) {
      expect(sql).toContain(`CREATE POLICY tenant_isolation_select ON ${table}`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation_mod ON ${table}`);
    }
    expect(sql).toContain("NULLIF(current_setting('app.current_tenant_id', true), '')::uuid");
    expect(sql).toContain("WITH CHECK");
  });

  it("creates the app role as NOSUPERUSER NOBYPASSRLS (R6.3)", () => {
    const roleSql = createAppRoleSql("tenantforge_app", "pw");
    expect(roleSql).toContain("NOSUPERUSER NOBYPASSRLS");
    expect(roleSql).toContain("CREATE ROLE tenantforge_app");
  });

  it("grants only DML (not DDL/superuser) to the app role", () => {
    const g = grantsSql("tenantforge_app");
    expect(g).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    expect(g).not.toMatch(/SUPERUSER|BYPASSRLS/);
  });
});
