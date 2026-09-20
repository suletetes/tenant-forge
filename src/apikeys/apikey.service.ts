import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { errors } from "../errors";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface ApiKeyRow {
  id: string;
  name: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Creates a tenant-scoped API key (R5.1). Returns the PLAINTEXT key exactly once; only the hash is
 * persisted. Runs on the request's tenant-scoped connection (RLS stamps/isolates the tenant).
 */
export async function createApiKey(
  db: PoolClient,
  actor: { tenantId: string; userId: string },
  name: string,
): Promise<{ id: string; key: string }> {
  const key = `tf_${randomBytes(24).toString("base64url")}`;
  const res = await db.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, name, hashed_key) VALUES ($1,$2,$3) RETURNING id`,
    [actor.tenantId, name, hashKey(key)],
  );
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
     VALUES ($1,$2,'apikey.created',$3)`,
    [actor.tenantId, actor.userId, res.rows[0]!.id],
  );
  return { id: res.rows[0]!.id, key }; // plaintext returned once (R5.1)
}

/** Lists the tenant's API keys (never the plaintext or hash). */
export async function listApiKeys(db: PoolClient): Promise<ApiKeyRow[]> {
  const res = await db.query<ApiKeyRow>(
    `SELECT id, name, last_used_at, revoked_at, created_at FROM api_keys ORDER BY created_at DESC`,
  );
  return res.rows;
}

/** Revokes a key (R5.3). 404 if it doesn't exist in this tenant (RLS-scoped). */
export async function revokeApiKey(
  db: PoolClient,
  actor: { tenantId: string; userId: string },
  id: string,
): Promise<void> {
  const res = await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  if (res.rowCount === 0) throw errors.notFound("API key not found");
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
     VALUES ($1,$2,'apikey.revoked',$3)`,
    [actor.tenantId, actor.userId, id],
  );
}

export interface ApiKeyPrincipal {
  tenantId: string;
  keyId: string;
}

/**
 * Resolves an API key for authentication (R5.2/R5.3). Looks up by hash on the owner pool (no
 * tenant context exists yet; the unique hash is the only selector — cannot enumerate other
 * tenants). Rejects revoked keys (R5.3). Bumps last_used_at without blocking the request path
 * (R5.4 — fire-and-forget update).
 */
export async function authenticateApiKey(
  ownerPool: Pool,
  presentedKey: string,
): Promise<ApiKeyPrincipal> {
  const res = await ownerPool.query<{ id: string; tenant_id: string; revoked_at: string | null }>(
    `SELECT id, tenant_id, revoked_at FROM api_keys WHERE hashed_key = $1 LIMIT 1`,
    [hashKey(presentedKey)],
  );
  const row = res.rows[0];
  if (!row || row.revoked_at) throw errors.unauthorized("Invalid API key");
  // Non-blocking last_used_at bump (R5.4).
  void ownerPool
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => {});
  return { tenantId: row.tenant_id, keyId: row.id };
}
