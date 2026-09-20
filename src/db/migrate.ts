import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createAppRoleSql, grantsSql, rlsPolicySql } from "./rls";

/**
 * Migration runner (R18.2). Runs as the MIGRATION (owner) role — NEVER the app role and
 * NEVER with RLS active on the connection (design §4.3). Steps:
 *   1. Apply Drizzle-generated table DDL from ./drizzle.
 *   2. Create/repair the non-privileged app role (NOSUPERUSER NOBYPASSRLS).
 *   3. ENABLE + FORCE RLS + policies on every tenant-scoped table.
 *   4. Grant runtime DML to the app role.
 *
 * Accepts explicit params so tests can drive it against a Testcontainers instance.
 */
export interface MigrateParams {
  migrationUrl: string;
  appRole: string;
  appPassword: string;
  migrationsFolder?: string;
}

export async function runMigrations(params: MigrateParams): Promise<void> {
  const { migrationUrl, appRole, appPassword, migrationsFolder = "./drizzle" } = params;
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    const db = drizzle(pool);
    // 1. Table DDL
    await migrate(db, { migrationsFolder });
    // 2. App role
    await pool.query(createAppRoleSql(appRole, appPassword));
    // 3. RLS enable/force/policies
    await pool.query(rlsPolicySql());
    // 4. Grants
    await pool.query(grantsSql(appRole));
  } finally {
    await pool.end();
  }
}

// CLI entrypoint: `npm run db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  const appRole = process.env.APP_DB_ROLE ?? "tenantforge_app";
  const appPassword = process.env.APP_DB_PASSWORD ?? "app_pw";
  if (!migrationUrl) {
    console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is required");
    process.exit(1);
  }
  runMigrations({ migrationUrl, appRole, appPassword })
    .then(() => {
      console.log("migrations applied (tables + roles + RLS)");
      process.exit(0);
    })
    .catch((err) => {
      console.error("migration failed", err);
      process.exit(1);
    });
}
