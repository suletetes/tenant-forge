import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { errors } from "../errors";
import { dummyPasswordHash, verifyPassword } from "./password";
import type { AccessClaims, TokenService } from "./token.service";

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  userId: string;
  role: AccessClaims["role"];
}

/**
 * Authenticates a user and issues tokens (R3.1).
 *
 * Login has no prior tenant context, so the user lookup runs on the owner pool by email.
 * (Email is unique per tenant; for MVP we resolve the first match. A production multi-tenant
 * login would disambiguate by org slug/subdomain — noted for a later task.) A fresh refresh
 * family_id is minted per login; only the token HASH is stored (R3.2).
 *
 * Uniform failure for bad email OR bad password → 401 (no user enumeration).
 */
export async function login(
  ownerPool: Pool,
  tokens: TokenService,
  input: LoginInput,
): Promise<LoginResult> {
  const found = await ownerPool.query<{
    id: string;
    tenant_id: string;
    password_hash: string;
    role: AccessClaims["role"];
  }>(
    `SELECT u.id, u.tenant_id, u.password_hash, u.role
     FROM users u
     JOIN organizations o ON o.id = u.tenant_id
     WHERE u.email = $1 AND o.deleted_at IS NULL
     LIMIT 1`,
    [input.email.toLowerCase()],
  );

  const row = found.rows[0];
  // Uniform timing (R3, anti-enumeration): always run a verify. If the user doesn't exist, verify
  // against a dummy hash so response time doesn't reveal whether the email is registered.
  const hashToCheck = row?.password_hash ?? (await dummyPasswordHash());
  const ok = await verifyPassword(hashToCheck, input.password);
  if (!row || !ok) throw errors.unauthorized("Invalid credentials");

  const accessToken = await tokens.signAccessToken({
    sub: row.id,
    tenantId: row.tenant_id,
    role: row.role,
  });

  const familyId = randomUUID();
  const { token: refreshToken, hash } = tokens.generateRefreshToken();
  const expiresAt = tokens.refreshExpiry();

  // Store the refresh token hash under the tenant's RLS context.
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [row.tenant_id]);
    await client.query(
      `INSERT INTO refresh_tokens (tenant_id, user_id, hashed_token, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.tenant_id, row.id, hash, familyId, expiresAt],
    );
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
       VALUES ($1, $2, 'auth.login', $3)`,
      [row.tenant_id, row.id, row.id],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.query("RESET app.current_tenant_id").catch(() => {});
    client.release();
  }

  return { accessToken, refreshToken, tenantId: row.tenant_id, userId: row.id, role: row.role };
}
