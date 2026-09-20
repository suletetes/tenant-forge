import type { Pool, PoolClient } from "pg";
import { errors } from "../errors";

/** Active-project quota per plan (R21.1). null = unlimited. */
export const PROJECT_QUOTA: Record<string, number | null> = {
  free: 3,
  starter: 25,
  pro: null,
};

export type SubStatus = "active" | "trialing" | "past_due" | "canceled";

/**
 * Resolves a tenant's effective subscription status + plan from persisted state (R11.3).
 * Falls back to the organization's plan with an implicit "active" status when no subscription
 * row exists yet (e.g. free tenants that never subscribed).
 */
export async function getBillingState(
  ownerPool: Pool,
  tenantId: string,
): Promise<{ status: SubStatus; plan: string }> {
  const org = await ownerPool.query<{ plan: string }>(
    `SELECT plan FROM organizations WHERE id = $1`,
    [tenantId],
  );
  const plan = org.rows[0]?.plan ?? "free";
  const sub = await ownerPool.query<{ status: SubStatus }>(
    `SELECT status FROM subscriptions WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [tenantId],
  );
  const status = (sub.rows[0]?.status as SubStatus) ?? "active";
  return { status, plan };
}

/**
 * Degraded-access enforcement (R11.1). Writes are blocked for past_due/canceled with 402;
 * reads are always allowed. Called by the write paths.
 */
export function assertWriteAllowed(status: SubStatus): void {
  if (status === "past_due" || status === "canceled") {
    throw errors.paymentRequired(`Writes are disabled while the subscription is ${status}`);
  }
}

/**
 * Project quota enforcement (R21.1/R21.2). Counts active projects on the tenant-scoped
 * connection (RLS already limits to this tenant) and rejects creation over the plan cap with
 * 403 QUOTA_EXCEEDED.
 */
export async function assertProjectQuota(db: PoolClient, plan: string): Promise<void> {
  // Distinguish "unknown plan" (fall back to free) from "unlimited" (null). Using ?? would
  // wrongly treat null (unlimited) as nullish and fall back to the free cap.
  const cap = plan in PROJECT_QUOTA ? PROJECT_QUOTA[plan]! : PROJECT_QUOTA.free!;
  if (cap === null) return; // unlimited (pro)
  const res = await db.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM projects WHERE status <> 'archived'`,
  );
  if (Number(res.rows[0]!.n) >= cap) {
    throw errors.quotaExceeded(`Plan '${plan}' allows at most ${cap} active projects`);
  }
}
