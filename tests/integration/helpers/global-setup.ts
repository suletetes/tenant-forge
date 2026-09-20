import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { execSync } from "node:child_process";

/**
 * Vitest globalSetup (runs ONCE for the whole test run). Starts a single Postgres server and a
 * single Redis, then exposes their connection info via environment variables. Integration suites
 * carve a fresh, isolated database per suite from the shared server (see helpers/postgres.ts) and
 * use per-suite Redis key prefixes — so suites stay isolated while we pay container-startup cost
 * only ONCE instead of ~19 times. This removes the sequential-run flakiness (container-start
 * timeouts under sustained Docker load).
 *
 * If Docker is unreachable, globalSetup is a no-op; suites detect the missing env and skip.
 */
function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let pg: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(): Promise<void> {
  if (!dockerAvailable()) {
    process.env.TF_TEST_NO_DOCKER = "1";
    return;
  }
  pg = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("postgres")
    .withUsername("owner")
    .withPassword("owner_pw")
    .start();
  redis = await new RedisContainer("redis:7-alpine").start();

  // Admin URL points at the default `postgres` db; helpers CREATE DATABASE per suite from here.
  process.env.TF_TEST_PG_HOST = pg.getHost();
  process.env.TF_TEST_PG_PORT = String(pg.getMappedPort(5432));
  process.env.TF_TEST_REDIS_URL = redis.getConnectionUrl();
}

export async function teardown(): Promise<void> {
  await redis?.stop().catch(() => {});
  await pg?.stop().catch(() => {});
}
