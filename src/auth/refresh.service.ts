import type { Pool, PoolClient } from "pg";
import { errors } from "../errors";
import { hashRefreshToken, type AccessClaims, type TokenService } from "./token.service";

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

async function withTenantTx<T>(
  ownerPool: Pool,
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.query("RESET app.current_tenant_id").catch(() => {});
    c.release();
  }
}

/**
 * Rotates a refresh token (R3.3, R3.4, R3.6).
 *
 * The presented token is looked up by hash. Because refresh_tokens is tenant-scoped under RLS
 * and there is no tenant context yet, the lookup runs on the owner pool by the unique hash (it
 * cannot enumerate other tenants — the hash is the only selector; design §5.2 bootstrapping note).
 *
 * - Valid & unused → issue a new access token + new refresh token in the SAME family; mark the
 *   presented token used_at.
 * - Reused (already used) or revoked → REVOKE THE ENTIRE FAMILY and 401 (theft signal, R3.4),
 *   UNLESS within the rotation-overlap window right after its own rotation (R3.6).
 */
export async function rotateRefreshToken(
  ownerPool: Pool,
  tokens: TokenService,
  presentedToken: string,
  opts: { rotationOverlapMs?: number } = {},
): Promise<RefreshResult> {
  const overlapMs = opts.rotationOverlapMs ?? 10_000;
  const hashed = hashRefreshToken(presentedToken);

  const found = await ownerPool.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    family_id: string;
    used_at: string | null;
    revoked_at: string | null;
    expires_at: string;
    role: AccessClaims["role"];
  }>(
    `SELECT rt.id, rt.tenant_id, rt.user_id, rt.family_id, rt.used_at, rt.revoked_at,
            rt.expires_at, u.role
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.hashed_token = $1 LIMIT 1`,
    [hashed],
  );
  const row = found.rows[0];
  if (!row) throw errors.unauthorized("Invalid refresh token");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw errors.unauthorized("Refresh token expired");
  }

  // Reuse detection (R3.4): a revoked token, or a used token outside the overlap window,
  // means the family may be compromised → revoke the whole family.
  const usedAt = row.used_at ? new Date(row.used_at).getTime() : null;
  const withinOverlap = usedAt !== null && Date.now() - usedAt <= overlapMs;
  if (row.revoked_at || (usedAt !== null && !withinOverlap)) {
    await withTenantTx(ownerPool, row.tenant_id, async (c) => {
      await c.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
         VALUES ($1,$2,'auth.refresh_reuse_detected',$3)`,
        [row.tenant_id, row.user_id, row.family_id],
      );
    });
    throw errors.unauthorized("Refresh token reuse detected");
  }

  // Happy path: rotate within the same family.
  const accessToken = await tokens.signAccessToken({
    sub: row.user_id,
    tenantId: row.tenant_id,
    role: row.role,
  });
  const { token: refreshToken, hash: newHash } = tokens.generateRefreshToken();
  const expiresAt = tokens.refreshExpiry();

  await withTenantTx(ownerPool, row.tenant_id, async (c) => {
    // Mark the presented token used (idempotent if within overlap).
    await c.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [
      row.id,
    ]);
    await c.query(
      `INSERT INTO refresh_tokens (tenant_id, user_id, hashed_token, family_id, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [row.tenant_id, row.user_id, newHash, row.family_id, expiresAt],
    );
  });

  return { accessToken, refreshToken };
}
