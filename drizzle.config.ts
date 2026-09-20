import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config. Migrations are generated from the schema and applied via the
 * MIGRATION (owner) role — never the app role (R18.2, design §4.3).
 */
export default defineConfig({
  schema: "./src/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
});
