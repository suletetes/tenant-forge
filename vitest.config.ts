import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // One Postgres + one Redis container for the whole run (started here, reused by every suite).
    globalSetup: ["tests/integration/helpers/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites share one Postgres + one Redis (started in globalSetup). Run suites sequentially
    // (single fork) so the small shared Postgres isn't hit by parallel CREATE DATABASE / many
    // pools at once. Still fast: container startup is paid ONCE, not per suite.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
