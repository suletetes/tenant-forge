import type { Pool } from "pg";

/**
 * Cancels (soft-deletes) a tenant (R2.1, R2.2). Sets organizations.deleted_at and revokes ALL of
 * the tenant's refresh-token families so existing sessions can't be refreshed. Runs on the owner
 * pool: organizations is global, and we set the tenant GUC so the refresh_tokens UPDATE (RLS)
 * applies. A background purge job (R2.4) is documented but out of scope for the API path.
 */
export async function cancelTenant(
  ownerPool: Pool,
  actor: { tenantId: string; userId: string },
): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [actor.tenantId]);
    await client.query(`UPDATE organizations SET deleted_at = now() WHERE id = $1`, [
      actor.tenantId,
    ]);
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL`,
    );
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
       VALUES ($1,$2,'org.cancelled',$1)`,
      [actor.tenantId, actor.userId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.query("RESET app.current_tenant_id").catch(() => {});
    client.release();
  }
}

/**
 * Returns true if the tenant is soft-deleted. Used by the auth path to reject requests from a
 * cancelled tenant with 403 (R2.3).
 */
export async function isTenantDeleted(ownerPool: Pool, tenantId: string): Promise<boolean> {
  const res = await ownerPool.query<{ deleted_at: string | null }>(
    `SELECT deleted_at FROM organizations WHERE id = $1`,
    [tenantId],
  );
  return res.rows[0]?.deleted_at != null;
}
