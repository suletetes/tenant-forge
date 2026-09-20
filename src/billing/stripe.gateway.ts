import Stripe from "stripe";

/**
 * The subset of Stripe operations TenantForge uses. Depending on this interface (not the SDK
 * directly) lets unit tests inject a mock — no live keys needed (Stripe test mode is used in
 * real environments via Secrets Manager, R9.4).
 */
export interface StripeGateway {
  createCustomer(input: { email: string; tenantId: string }): Promise<{ id: string }>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    tenantId: string;
  }): Promise<{ id: string; url: string | null }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Refetch the current subscription object (source of truth for webhook sync, R10.4). */
  getSubscription(id: string): Promise<{
    id: string;
    status: string;
    items: { plan: string | null };
    currentPeriodEnd: number | null;
    customerId: string;
  }>;
  /** Verify + parse a webhook payload (R10.1). Throws on bad signature. */
  constructEvent(rawBody: Buffer | string, signature: string): { id: string; type: string; data: { object: unknown } };
}

/** Real adapter over the Stripe SDK. */
export class RealStripeGateway implements StripeGateway {
  private readonly stripe: Stripe;
  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createCustomer(input: { email: string; tenantId: string }): Promise<{ id: string }> {
    const c = await this.stripe.customers.create({
      email: input.email,
      metadata: { tenant_id: input.tenantId },
    });
    return { id: c.id };
  }

  async createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    tenantId: string;
  }): Promise<{ id: string; url: string | null }> {
    const s = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      subscription_data: { metadata: { tenant_id: input.tenantId } },
    });
    return { id: s.id, url: s.url };
  }

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const s = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: s.url };
  }

  async getSubscription(id: string): Promise<{
    id: string;
    status: string;
    items: { plan: string | null };
    currentPeriodEnd: number | null;
    customerId: string;
  }> {
    const s = await this.stripe.subscriptions.retrieve(id);
    const price = s.items.data[0]?.price;
    return {
      id: s.id,
      status: s.status,
      items: { plan: (price?.metadata?.plan ?? price?.nickname) ?? null },
      currentPeriodEnd: s.current_period_end ?? null,
      customerId: typeof s.customer === "string" ? s.customer : s.customer.id,
    };
  }

  constructEvent(
    rawBody: Buffer | string,
    signature: string,
  ): { id: string; type: string; data: { object: unknown } } {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return { id: event.id, type: event.type, data: { object: event.data.object } };
  }
}
