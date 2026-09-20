import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { errors } from "../errors";
import { hashPassword } from "../auth/password";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
 * Requests a password reset. ALWAYS returns the same shape regardless of whether the email
 * exists (R22.1). If it maps to a user, a hashed single-use token is stored; the plaintext is
 * returned here for delivery by the caller (email in production). If no user, returns null token.
 */
export async function requestPasswordReset(
  ownerPool: Pool,
  email: string,
  ttlMs = 3600 * 1000,
): Promise<{ token: string | null }> {
  const found = await ownerPool.query<{ id: string; tenant_id: string }>(
    `SELECT u.id, u.tenant_id FROM users u
     JOIN organizations o ON o.id=u.tenant_id
     WHERE u.email=$1 AND o.deleted_at IS NULL LIMIT 1`,
    [email.toLowerCase()],
  );
  const row = found.rows[0];
  if (!row) return { token: null }; // uniform success; no enumeration

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await withTenantTx(ownerPool, row.tenant_id, async (c) => {
    await c.query(
      `INSERT INTO auth_tokens (tenant_id, user_id, type, hashed_token, expires_at)
       VALUES ($1,$2,'password_reset',$3,$4)`,
      [row.tenant_id, row.id, hashToken(token), expiresAt],
    );
  });
  return { token };
}

/**
 * Confirms a reset: updates the password hash, consumes the token, and revokes ALL of the
 * user's refresh-token families (R22.3). Invalid/expired/consumed token → 400 (R22.4).
 */
export async function confirmPasswordReset(
  ownerPool: Pool,
  input: { token: string; newPassword: string },
): Promise<void> {
  const hashed = hashToken(input.token);
  const tok = await ownerPool.query<{ id: string; tenant_id: string; user_id: string }>(
    `SELECT id, tenant_id, user_id FROM auth_tokens
     WHERE hashed_token=$1 AND type='password_reset' AND consumed_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [hashed],
  );
  const row = tok.rows[0];
  if (!row) throw errors.badRequest("Reset token invalid or expired"); // R22.4
  const passwordHash = await hashPassword(input.newPassword);
  await withTenantTx(ownerPool, row.tenant_id, async (c) => {
    await c.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [passwordHash, row.user_id]);
    await c.query(`UPDATE auth_tokens SET consumed_at=now() WHERE id=$1`, [row.id]);
    // Revoke every refresh-token family for this user (R22.3).
    await c.query(
      `UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`,
      [row.user_id],
    );
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
       VALUES ($1,$2,'password.reset',$3)`,
      [row.tenant_id, row.user_id, row.user_id],
    );
  });
}
