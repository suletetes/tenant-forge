/**
 * RLS coverage lint (Task 8, R6.2 / design §3.2).
 *
 * Static check runnable in CI WITHOUT a database or the full app: for every table in the
 * TENANT_SCOPED_TABLES registry, assert the generated RLS SQL contains ENABLE, FORCE, and both
 * policies. Fails the build (exit 1) if any tenant-scoped table lacks full RLS coverage — the
 * guard against a new tenant table shipping without isolation.
 */
import { rlsPolicySql } from "../db/rls";
import { TENANT_SCOPED_TABLES } from "../db/schema/index";

function main(): void {
  const sql = rlsPolicySql();
  const failures: string[] = [];

  for (const table of TENANT_SCOPED_TABLES) {
    const checks: Array<[string, boolean]> = [
      ["ENABLE RLS", sql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`)],
      ["FORCE RLS", sql.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`)],
      ["SELECT policy", sql.includes(`CREATE POLICY tenant_isolation_select ON ${table}`)],
      ["ALL policy (WITH CHECK)", sql.includes(`CREATE POLICY tenant_isolation_mod ON ${table}`)],
    ];
    for (const [label, ok] of checks) {
      if (!ok) failures.push(`  ✗ ${table}: missing ${label}`);
    }
  }

  if (failures.length > 0) {
    console.error("RLS coverage lint FAILED — tenant-scoped tables without full isolation:");
    console.error(failures.join("\n"));
    console.error(
      "\nEvery table in TENANT_SCOPED_TABLES must have ENABLE + FORCE + select/mod policies.",
    );
    process.exit(1);
  }

  console.log(
    `RLS coverage lint OK — ${TENANT_SCOPED_TABLES.length} tenant-scoped tables fully isolated:`,
  );
  console.log(TENANT_SCOPED_TABLES.map((t) => `  ✓ ${t}`).join("\n"));
}

main();
