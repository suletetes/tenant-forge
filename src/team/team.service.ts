import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { errors } from "../errors";
import { hashPassword } from "../auth/password";
import { requireRole, type Role } from "../auth/rbac";

export type InvitableRole = "admin" | "member";

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

/** Creates a single-use invitation; returns the plaintext token (delivered out-of-band). R20.1 */
export async function createInvitation(
  ownerPool: Pool,
  actor: { tenantId: string; userId: string; role: Role },
  input: { email: string; role: InvitableRole },
  ttlMs = 7 * 24 * 3600 * 1000,
): Promise<{ token: string }> {
  requireRole(actor.role, "admin"); // R20.2 — admin or owner may invite
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await withTenantTx(ownerPool, actor.tenantId, async (c) => {
    await c.query(
      `INSERT INTO invitations (tenant_id, email, role, hashed_token, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [actor.tenantId, input.email.toLowerCase(), input.role, hashToken(token), expiresAt],
    );
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
       VALUES ($1,$2,'invitation.created',$3)`,
      [actor.tenantId, actor.userId, input.email.toLowerCase()],
    );
  });
  return { token };
}

/** Accepts an invitation, creating the user in the inviting tenant. R20.3/R20.4 */
export async function acceptInvitation(
  ownerPool: Pool,
  input: { token: string; password: string },
): Promise<{ userId: string; tenantId: string }> {
  const hashed = hashToken(input.token);
  const inv = await ownerPool.query<{ id: string; tenant_id: string; email: string; role: string }>(
    `SELECT id, tenant_id, email, role FROM invitations
     WHERE hashed_token=$1 AND consumed_at IS NULL AND expires_at > now() LIMIT 1`,
    [hashed],
  );
  const row = inv.rows[0];
  if (!row) throw errors.gone("Invitation invalid or expired"); // R20.4
  const passwordHash = await hashPassword(input.password);
  return withTenantTx(ownerPool, row.tenant_id, async (c) => {
    const created = await c.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [row.tenant_id, row.email, passwordHash, row.role],
    );
    await c.query(`UPDATE invitations SET consumed_at=now() WHERE id=$1`, [row.id]);
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
       VALUES ($1,$2,'invitation.accepted',$3)`,
      [row.tenant_id, created.rows[0]!.id, row.email],
    );
    return { userId: created.rows[0]!.id, tenantId: row.tenant_id };
  });
}

/** Changes a user's role, enforcing the last-owner guard. R20.5/R20.6 */
export async function changeRole(
  ownerPool: Pool,
  actor: { tenantId: string; userId: string; role: Role },
  targetUserId: string,
  newRole: Role,
): Promise<void> {
  requireRole(actor.role, "admin");
  await withTenantTx(ownerPool, actor.tenantId, async (c) => {
    const target = await c.query<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [
      targetUserId,
    ]);
    if (!target.rows[0]) throw errors.notFound("User not found");

    // Last-owner guard: if demoting the last owner, block (R20.6).
    if (target.rows[0].role === "owner" && newRole !== "owner") {
      const owners = await c.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM users WHERE role='owner'`,
      );
      if (Number(owners.rows[0]!.n) <= 1) throw errors.conflict("Organization must retain an owner");
    }

    await c.query(`UPDATE users SET role=$1 WHERE id=$2`, [newRole, targetUserId]);
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target, metadata)
       VALUES ($1,$2,'user.role_changed',$3,$4)`,
      [actor.tenantId, actor.userId, targetUserId, JSON.stringify({ newRole })],
    );
  });
}
