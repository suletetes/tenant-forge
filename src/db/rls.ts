import { TENANT_SCOPED_TABLES } from "./schema/index";

/**
 * Generates the SQL that enforces tenant isolation (design §4). Applied by the migration
 * runner AFTER the generated table DDL, as the migrator/owner role.
 *
 * Key guarantees:
 *  - ENABLE + FORCE ROW LEVEL SECURITY on every tenant-scoped table (R6.2). FORCE makes the
 *    policy apply even to the table owner.
 *  - Policies filter on the transaction-local GUC `app.current_tenant_id` (R6.5). Using the
 *    two-arg current_setting(..., true) returns NULL when unset so unscoped queries return
 *    zero rows / fail closed (R6.8) rather than erroring ambiguously.
 *  - USING for reads, WITH CHECK for writes so a tenant cannot write another tenant's id (R6.7).
 */
export function rlsPolicySql(): string {
  const stmts: string[] = [];
  for (const table of TENANT_SCOPED_TABLES) {
    stmts.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    stmts.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    stmts.push(`DROP POLICY IF EXISTS tenant_isolation_select ON ${table};`);
    stmts.push(
      `CREATE POLICY tenant_isolation_select ON ${table} FOR SELECT ` +
        `USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);`,
    );
    stmts.push(`DROP POLICY IF EXISTS tenant_isolation_mod ON ${table};`);
    stmts.push(
      `CREATE POLICY tenant_isolation_mod ON ${table} FOR ALL ` +
        `USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid) ` +
        `WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);`,
    );
  }
  return stmts.join("\n");
}

/**
 * Grants runtime DML to the app role. The app role is created by createAppRoleSql() with
 * NOSUPERUSER NOBYPASSRLS (R6.3) so RLS is unconditional for it.
 *
 * @param appRole  the app role name (e.g. "tenantforge_app")
 */
export function grantsSql(appRole: string): string {
  return [
    `GRANT USAGE ON SCHEMA public TO ${appRole};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public ` +
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};`,
  ].join("\n");
}

/**
 * Idempotently creates the non-privileged app role (R6.3). In AWS the password comes from
 * Secrets Manager; here it is passed in. NOSUPERUSER NOBYPASSRLS is the whole point.
 */
export function createAppRoleSql(appRole: string, password: string): string {
  // Password is a controlled internal value (from Secrets Manager / env), not user input.
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${appRole}') THEN
    CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE ${appRole} NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;`;
}
