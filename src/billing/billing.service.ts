import type { Pool } from "pg";
import { AppError, errors } from "../errors";
import type { StripeGateway } from "./stripe.gateway";

/**
 * Ensures the tenant has a Stripe customer, persisting organizations.stripe_customer_id (R9.1).
 * Runs on the owner pool (organizations is a global table, not tenant-RLS-scoped).
 *
 * Race-safe: the read locks the organizations row (SELECT ... FOR UPDATE) so two concurrent
 * checkout calls for the same tenant serialize — the second sees the customer id written by the
 * first instead of both creating (and orphaning) duplicate Stripe customers.
 */
export async function ensureCustomer(
  ownerPool: Pool,
  stripe: StripeGateway,
  tenantId: string,
): Promise<string> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    const org = await client.query<{ stripe_customer_id: string | null; owner_email: string | null }>(
      `SELECT o.stripe_customer_id,
              (SELECT email FROM users u WHERE u.tenant_id = o.id ORDER BY created_at ASC LIMIT 1) AS owner_email
       FROM organizations o WHERE o.id = $1
       FOR UPDATE`,
      [tenantId],
    );
    const row = org.rows[0];
    if (!row) throw errors.notFound("Organization not found");
    if (row.stripe_customer_id) {
      await client.query("COMMIT");
      return row.stripe_customer_id;
    }
    if (!row.owner_email) {
      // No user to bill — cannot create a Stripe customer. Treat as a client-side precondition.
      throw errors.conflict("Organization has no owner to bill");
    }

    let customer: { id: string };
    try {
      customer = await stripe.createCustomer({ email: row.owner_email, tenantId });
    } catch (err) {
      throw wrapStripeError(err, "Failed to create billing customer");
    }
    // Only write if still unset (defensive; the row lock already guarantees exclusivity).
    await client.query(
      `UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL`,
      [customer.id, tenantId],
    );
    await client.query("COMMIT");
    return customer.id;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Starts a Checkout session for a subscription (R9.1). Returns the redirect URL. */
export async function startCheckout(
  ownerPool: Pool,
  stripe: StripeGateway,
  input: { tenantId: string; priceId: string; successUrl: string; cancelUrl: string },
): Promise<{ url: string; sessionId: string }> {
  const customerId = await ensureCustomer(ownerPool, stripe, input.tenantId);
  let session: { id: string; url: string | null };
  try {
    session = await stripe.createCheckoutSession({
      customerId,
      priceId: input.priceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      tenantId: input.tenantId,
    });
  } catch (err) {
    throw wrapStripeError(err, "Failed to start checkout session");
  }
  // Stripe can return a null url; a "success" with no usable URL is a server-side failure.
  if (!session.url) {
    throw errors.badGateway("Checkout session has no redirect URL");
  }
  return { url: session.url, sessionId: session.id };
}

/** Opens the Stripe Customer Portal for self-service plan management (R9.2). */
export async function openPortal(
  ownerPool: Pool,
  stripe: StripeGateway,
  input: { tenantId: string; returnUrl: string },
): Promise<{ url: string }> {
  const customerId = await ensureCustomer(ownerPool, stripe, input.tenantId);
  let session: { url: string };
  try {
    session = await stripe.createPortalSession({ customerId, returnUrl: input.returnUrl });
  } catch (err) {
    throw wrapStripeError(err, "Failed to open billing portal");
  }
  if (!session.url) {
    throw errors.badGateway("Portal session has no redirect URL");
  }
  return { url: session.url };
}

/**
 * Maps an error thrown by the Stripe gateway to a clean client-facing error. AppErrors (e.g. a
 * notFound from ensureCustomer) pass through unchanged; anything else is an upstream failure and
 * becomes a 502 so no Stripe/driver internals leak to the client (R14.5).
 */
function wrapStripeError(err: unknown, message: string): Error {
  if (err instanceof AppError) return err;
  return errors.badGateway(message);
}
