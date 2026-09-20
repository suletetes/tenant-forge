import { writeFileSync } from "node:fs";
import { buildApp } from "../app";
import type { AppConfig } from "../config";

/**
 * Generates openapi.json from the live route schemas and writes it to the repo (R14.2), so the
 * API contract is reviewable in PRs. Run: `npm run openapi:gen`.
 */
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "silent" as AppConfig["LOG_LEVEL"],
  DATABASE_URL: "postgresql://unused",
  JWT_SIGNING_SECRET: "openapi-generation-secret-at-least-32b!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
};

async function main(): Promise<void> {
  // No pools/stripe/redis needed — routes register with just the schemas for spec generation.
  const app = buildApp(config);
  await app.ready();
  const spec = app.swagger();
  writeFileSync("openapi.json", JSON.stringify(spec, null, 2) + "\n");
  await app.close();
  console.log("wrote openapi.json");
}

void main();
