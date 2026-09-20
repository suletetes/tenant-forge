import type { Pool } from "pg";
import { AppError, errors } from "../errors";
import type { StripeGateway } from "./stripe.gateway";

export type WebhookOutcome = "processed" | "duplicate" | "ignored";

/** Maps a Stripe subscription status to our internal status + downgrade rule. */
function mapStatus(stripeStatus: string): { status: string; plan?: string } {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return { status: stripeStatus };
    case "past_due":
    case "unpaid":
      return { status: "past_due" };
    case "canceled":
    case "incomplete_expired":
      return { status: "canceled", plan: "free" }; // downgrade entitlements (R10.6)
    default:
      return { status: stripeStatus };
  }
}

/**
 * Processes a verified Stripe event idempotently (R10.3, R10.4).
 *
 * 1. Determine relevance and resolve the subscription id BEFORE opening a transaction.
 * 2. REFETCH the subscription from the Stripe API (source of truth) rather than trusting the
 *    payload — tolerates out-of-order delivery. An upstream failure here throws so the webhook
 *    returns non-2xx and Stripe retries (the event is NOT yet recorded as processed).
 * 3. In ONE transaction: insert event.id into processed_webhooks (UNIQUE) as the dedup guard,
 *    then sync subscriptions.status + organizations.plan. A unique violation (23505) means the
 *    event was already processed → rollback + return "duplicate". Any other failure rolls back
 *    the ledger row too, so a transient error does NOT permanently mark the event processed.
 */
export async function processWebhookEvent(
  ownerPool: Pool,
  stripe: StripeGateway,
  event: { id: string; type: string; data: { object: unknown } },
): Promise<WebhookOutcome> {
  const relevant = new Set([
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.created",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
  ]);

  // Irrelevant events: record them as processed (dedup) but do no work.
  if (!relevant.has(event.type)) {
    return (await recordOnly(ownerPool, event.id)) ? "ignored" : "duplicate";
  }

  // 1. Resolve the subscription id from the event.
  const obj = event.data.object as { id?: string; subscription?: string; customer?: string };
  const subId = event.type.startsWith("customer.subscription.") ? obj.id : obj.subscription;
  if (!subId) {
    return (await recordOnly(ownerPool, event.id)) ? "ignored" : "duplicate";
  }

  // 2. REFETCH from Stripe (R10.4). On upstream failure, do NOT record the event — throw so the
  //    webhook returns non-2xx and Stripe redelivers.
  let sub: Awaited<ReturnType<StripeGateway["getSubscription"]>>;
  try {
    sub = await stripe.getSubscription(subId);
  } catch (err) {
    throw wrapStripeError(err, "Failed to fetch subscription for webhook sync");
  }
  const mapped = mapStatus(sub.status);

  // 3. Ledger insert + state sync in a single transaction (atomic dedup + work).
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");

    // Dedup guard: insert-before-work, but inside the tx so a later failure rolls it back.
    try {
      await client.query(`INSERT INTO processed_webhooks (event_id) VALUES ($1)`, [event.id]);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "23505") {
        await client.query("ROLLBACK").catch(() => {});
        return "duplicate";
      }
      throw err;
    }

    // Resolve the tenant that owns this Stripe customer (inside the tx for a consistent read).
    const tenant = await client.query<{ id: string; plan: string }>(
      `SELECT id, plan FROM organizations WHERE stripe_customer_id = $1`,
      [sub.customerId],
    );
    const org = tenant.rows[0];
    if (!org) {
      // Unknown customer: still commit the ledger row (nothing to sync, safe to dedup).
      await client.query("COMMIT");
      return "ignored";
    }

    const newPlan = mapped.plan ?? sub.items.plan ?? org.plan;
    const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null;

    await client.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [org.id]);
    // Upsert the subscription row.
    await client.query(
      `INSERT INTO subscriptions (tenant_id, stripe_subscription_id, status, plan, current_period_end, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (stripe_subscription_id)
       DO UPDATE SET status = EXCLUDED.status, plan = EXCLUDED.plan,
                     current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
      [org.id, sub.id, mapped.status, newPlan, periodEnd],
    );
    // organizations is global (no RLS) — update plan directly.
    await client.query(`UPDATE organizations SET plan = $1 WHERE id = $2`, [newPlan, org.id]);
    await client.query(
      `INSERT INTO audit_log (tenant_id, action, target, metadata)
       VALUES ($1,'billing.synced',$2,$3)`,
      [org.id, sub.id, JSON.stringify({ status: mapped.status, plan: newPlan, event: event.type })],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.query("RESET app.current_tenant_id").catch(() => {});
    client.release();
  }
  return "processed";
}

/**
 * Records an event id in the ledger without doing any sync work (for irrelevant/no-op events).
 * Returns true if newly recorded, false if it was already present (duplicate).
 */
async function recordOnly(ownerPool: Pool, eventId: string): Promise<boolean> {
  try {
    await ownerPool.query(`INSERT INTO processed_webhooks (event_id) VALUES ($1)`, [eventId]);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      return false;
    }
    throw err;
  }
}

/**
 * Maps an error thrown by the Stripe gateway to a clean error. AppErrors pass through; anything
 * else becomes a 502 so no Stripe/driver internals leak. In the webhook path this non-2xx result
 * signals Stripe to retry (the event is not yet recorded as processed).
 */
function wrapStripeError(err: unknown, message: string): Error {
  if (err instanceof AppError) return err;
  return errors.badGateway(message);
}
