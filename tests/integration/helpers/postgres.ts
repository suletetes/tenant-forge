import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Detects whether a Docker daemon is reachable so integration tests can skip gracefully
 * on machines where Docker Desktop is not running (and run fully in CI).
 * When the shared globalSetup ran, TF_TEST_PG_HOST is present and Docker is implicitly available.
 */
export async function dockerAvailable(): Promise<boolean> {
  if (process.env.TF_TEST_PG_HOST) return true;
  if (process.env.TF_TEST_NO_DOCKER === "1") return false;
  try {
    const { execSync } = await import("node:child_process");
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface StartedDb {
  /** Superuser/owner URL — used as the migration role. */
  migrationUrl: string;
  /** App-role URL — NOSUPERUSER NOBYPASSRLS, created by migrations. */
  appUrl: (appRole: string, appPw: string) => string;
  stop: () => Promise<unknown>;
}

/**
 * Returns an isolated Postgres database for a suite.
 *
 * Fast path (shared server from globalSetup): CREATE DATABASE a uniquely-named db on the shared
 * server (milliseconds), so every suite is fully isolated (row counts, RLS state) while paying
 * container startup only once. stop() drops the database.
 *
 * Fallback (no shared server): start a dedicated container for this suite (original behavior),
 * so a single suite can still be run standalone with just Docker.
 */
export async function startPostgres(): Promise<StartedDb> {
  const host = process.env.TF_TEST_PG_HOST;
  const port = process.env.TF_TEST_PG_PORT;

  if (host && port) {
    const dbName = `tf_${randomBytes(8).toString("hex")}`;
    const admin = new Client({
      host,
      port: Number(port),
      user: "owner",
      password: "owner_pw",
      database: "postgres",
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const url = (db: string, role = "owner", pw = "owner_pw") =>
      `postgresql://${role}:${pw}@${host}:${port}/${db}`;
    return {
      migrationUrl: url(dbName),
      appUrl: (role, pw) => url(dbName, role, pw),
      stop: async () => {
        // Drop the suite database (terminate connections first).
        const a = new Client({ host, port: Number(port), user: "owner", password: "owner_pw", database: "postgres" });
        await a.connect();
        await a.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await a.query(`DROP DATABASE IF EXISTS ${dbName}`);
        await a.end();
      },
    };
  }

  // Fallback: dedicated container for this suite.
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("tenantforge")
    .withUsername("owner")
    .withPassword("owner_pw")
    .start();
  const h = container.getHost();
  const p = container.getMappedPort(5432);
  return {
    migrationUrl: `postgresql://owner:owner_pw@${h}:${p}/tenantforge`,
    appUrl: (role, pw) => `postgresql://${role}:${pw}@${h}:${p}/tenantforge`,
    stop: () => container.stop(),
  };
}
