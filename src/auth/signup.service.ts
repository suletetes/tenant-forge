import type { Pool } from "pg";
import { errors } from "../errors";
import { hashPassword } from "./password";
import { slugify } from "./slug";

export interface SignupInput {
  organizationName: string;
  email: string;
  password: string;
}

export interface SignupResult {
  organizationId: string;
  ownerUserId: string;
  slug: string;
}

/**
 * Provisions a new tenant: organization + owner user + audit entry, all in ONE transaction (R1.1).
 * Any failure rolls the whole thing back so no orphan rows remain (R1.2).
 *
 * Runs on the owner/migrator pool: signup CREATES the tenant, so there is no prior tenant
 * context. We set the tenant GUC after minting the org id so the audit_log INSERT satisfies RLS.
 * Duplicate owner email within the tenant → 409 (R1.4); Postgres unique violation code = 23505.
 */
export async function signup(ownerPool: Pool, input: SignupInput): Promise<SignupResult> {
  const passwordHash = await hashPassword(input.password);
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");

    const slug = slugify(input.organizationName);
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, plan) VALUES ($1, $2, 'free') RETURNING id`,
      [input.organizationName, slug],
    );
    const organizationId = org.rows[0]!.id;

    // Bind tenant context so the RLS WITH CHECK on users/audit_log passes within this txn.
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [organizationId]);

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'owner') RETURNING id`,
      [organizationId, input.email.toLowerCase(), passwordHash],
    );
    const ownerUserId = user.rows[0]!.id;

    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target, metadata)
       VALUES ($1, $2, 'org.created', $3, $4)`,
      [organizationId, ownerUserId, organizationId, JSON.stringify({ slug })],
    );

    await client.query("COMMIT");
    return { organizationId, ownerUserId, slug };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      throw errors.conflict("Email already registered");
    }
    throw err;
  } finally {
    await client.query("RESET app.current_tenant_id").catch(() => {});
    client.release();
  }
}
