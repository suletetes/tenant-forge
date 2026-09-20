import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index";

/**
 * App-role connection pool (runtime traffic). This role has NOBYPASSRLS, so every query is
 * subject to RLS. Tenant context is set transaction-locally per request (Task 5, design §5).
 */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
export { schema };
