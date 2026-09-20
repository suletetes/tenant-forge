import type { PoolClient } from "pg";
import { TENANT_SCOPED_TABLES } from "../db/schema/index";

/**
 * Columns excluded from exports because they hold secret material (R24.4). Any column whose name
 * matches is dropped from every exported row.
 */
const SECRET_COLUMNS = new Set(["password_hash", "hashed_token", "hashed_key"]);

export interface TenantExport {
  generated_at: string;
  tables: Record<string, Record<string, unknown>[]>;
}

/**
 * Builds a full data export for the current tenant (R24).
 *
 * Runs on the request's tenant-scoped connection (req.db), so RLS guarantees only this tenant's
 * rows are included (R24.3) — no cross-tenant leakage even though we iterate every table. The
 * table list comes from the single-source-of-truth registry (R24.2) so tables added later are
 * not silently omitted. Secret columns are stripped (R24.4).
 *
 * Table names come from a compile-time constant array (TENANT_SCOPED_TABLES), never user input,
 * so the dynamic `FROM ${table}` has no injection surface.
 */
export async function buildTenantExport(db: PoolClient): Promise<TenantExport> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of TENANT_SCOPED_TABLES) {
    const res = await db.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
    tables[table] = res.rows.map((row) => {
      const clean: Record<string, unknown> = {};
      for (const [col, val] of Object.entries(row)) {
        if (!SECRET_COLUMNS.has(col)) clean[col] = val;
      }
      return clean;
    });
  }
  return { generated_at: new Date().toISOString(), tables };
}
