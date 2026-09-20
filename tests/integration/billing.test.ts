import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import type { AppConfig } from "../../src/config";
import { runMigrations } from "../../src/db/migrate";
import type { StripeGateway } from "../../src/billing/stripe.gateway";
import { dockerAvailable, startPostgres, type StartedDb } from "./helpers/postgres";

const APP_ROLE = "tenantforge_app";
const APP_PW = "app_pw";

const cfg = (dbUrl: string, migUrl: string): AppConfig => ({
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "silent" as AppConfig["LOG_LEVEL"],
  DATABASE_URL: dbUrl,
  MIGRATION_DATABASE_URL: migUrl,
  JWT_SIGNING_SECRET: "billing-integration-secret-32-bytes-plus!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
  STRIPE_PRICE_ID_LIST: ["price_pro"],
  BILLING_REDIRECT_ORIGIN_LIST: ["https://app.test"],
});

/** In-memory mock Stripe gateway. Records customers + lets tests drive subscription state. */
function mockStripe() {
  const state = {
    customers: new Map<string, { email: string; tenantId: string }>(),
    subscription: {
      id: "sub_test_1",
      status: "active",
      items: { plan: "pro" as string | null },
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 86400,
      customerId: "cus_test_1",
    },
  };
  let n = 0;
  let custN = 0;
  const gw: StripeGateway = {
    createCustomer: vi.fn(async ({ email, tenantId }) => {
      // Yield to widen the race window so the ensureCustomer row-lock is actually exercised
      // under concurrent checkout calls.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const id = `cus_test_${++custN}`; // unique per tenant
      state.customers.set(id, { email, tenantId });
      return { id };
    }),
    createCheckoutSession: vi.fn(async () => ({ id: `cs_${++n}`, url: "https://checkout.test/session" })),
    createPortalSession: vi.fn(async () => ({ url: "https://portal.test/session" })),
    getSubscription: vi.fn(async () => state.subscription),
    constructEvent: vi.fn((raw: Buffer | string) => JSON.parse(raw.toString())),
  };
  return { gw, state };
}

describe("Task 12/13 — Stripe billing + idempotent webhooks (R9, R10)", async () => {
  const hasDocker = await dockerAvailable();
  const maybe = hasDocker ? describe : describe.skip;

  let db: StartedDb;
  let ownerPool: Pool;
  let appPool: Pool;
  let app: FastifyInstance;
  let stripe: ReturnType<typeof mockStripe>;

  beforeAll(async () => {
    if (!hasDocker) return;
    db = await startPostgres();
    await runMigrations({
      migrationUrl: db.migrationUrl,
      appRole: APP_ROLE,
      appPassword: APP_PW,
      migrationsFolder: "./drizzle",
    });
    ownerPool = new Pool({ connectionString: db.migrationUrl, max: 3 });
    appPool = new Pool({ connectionString: db.appUrl(APP_ROLE, APP_PW), max: 5 });
    stripe = mockStripe();
    app = buildApp(cfg(db.appUrl(APP_ROLE, APP_PW), db.migrationUrl), {
      ownerPool,
      appPool,
      stripe: stripe.gw,
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (!hasDocker) return;
    await app?.close();
    await appPool?.end();
    await ownerPool?.end();
    await db?.stop();
  });

  async function owner(org: string, email: string) {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { organizationName: org, email, password: "password123" },
    });
    const tenantId = signup.json().organization_id as string;
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "password123" },
    });
    return { tenantId, token: login.json().access_token as string };
  }

  maybe("with a live app + mock Stripe", () => {
    it("checkout creates a Stripe customer and returns a URL (R9.1)", async () => {
      const { token } = await owner("Bill Co", "bill@x.test");
      const res = await app.inject({
        method: "POST",
        url: "/v1/billing/checkout",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          price_id: "price_pro",
          success_url: "https://app.test/ok",
          cancel_url: "https://app.test/no",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().checkout_url).toBe("https://checkout.test/session");
      expect(stripe.gw.createCustomer).toHaveBeenCalled();
    });

    it("checkout rejects an unknown price_id with 400 (R9.3)", async () => {
      const { token } = await owner("Badprice Co", "badprice@x.test");
      const res = await app.inject({
        method: "POST",
        url: "/v1/billing/checkout",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          price_id: "price_not_allowed",
          success_url: "https://app.test/ok",
          cancel_url: "https://app.test/no",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    });

    it("checkout rejects an off-origin redirect URL with 400", async () => {
      const { token } = await owner("Redirect Co", "redirect@x.test");
      const res = await app.inject({
        method: "POST",
        url: "/v1/billing/checkout",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          price_id: "price_pro",
          success_url: "https://evil.example/steal",
          cancel_url: "https://app.test/no",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    });

    it("checkout maps a null session URL to 502 (no false success)", async () => {
      const { token } = await owner("Nullurl Co", "nullurl@x.test");
      const original = stripe.gw.createCheckoutSession;
      stripe.gw.createCheckoutSession = vi.fn(async () => ({ id: "cs_null", url: null }));
      try {
        const res = await app.inject({
          method: "POST",
          url: "/v1/billing/checkout",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            price_id: "price_pro",
            success_url: "https://app.test/ok",
            cancel_url: "https://app.test/no",
          },
        });
        expect(res.statusCode).toBe(502);
        expect(res.json().error.code).toBe("BAD_GATEWAY");
      } finally {
        stripe.gw.createCheckoutSession = original;
      }
    });

    it("checkout maps a Stripe API failure to 502", async () => {
      const { token } = await owner("Apifail Co", "apifail@x.test");
      const original = stripe.gw.createCheckoutSession;
      stripe.gw.createCheckoutSession = vi.fn(async () => {
        throw new Error("stripe down");
      });
      try {
        const res = await app.inject({
          method: "POST",
          url: "/v1/billing/checkout",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            price_id: "price_pro",
            success_url: "https://app.test/ok",
            cancel_url: "https://app.test/no",
          },
        });
        expect(res.statusCode).toBe(502);
        expect(res.json().error.code).toBe("BAD_GATEWAY");
      } finally {
        stripe.gw.createCheckoutSession = original;
      }
    });

    it("concurrent checkouts create exactly one Stripe customer for a tenant (R9.1 race guard)", async () => {
      const { tenantId, token } = await owner("Race Co", "race@x.test");
      const before = (stripe.gw.createCustomer as ReturnType<typeof vi.fn>).mock.calls.length;

      const fire = () =>
        app.inject({
          method: "POST",
          url: "/v1/billing/checkout",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            price_id: "price_pro",
            success_url: "https://app.test/ok",
            cancel_url: "https://app.test/no",
          },
        });

      // Fire several checkouts for the SAME tenant concurrently.
      const results = await Promise.all([fire(), fire(), fire(), fire()]);
      for (const r of results) expect(r.statusCode).toBe(201);

      // Exactly one Stripe customer was created for this tenant (row lock serialized the rest).
      const after = (stripe.gw.createCustomer as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(after - before).toBe(1);

      // Exactly one customer id is persisted, and it is non-null.
      const org = await ownerPool.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM organizations WHERE id = $1`,
        [tenantId],
      );
      expect(org.rows[0]!.stripe_customer_id).toBeTruthy();

      const createdForTenant = [...stripe.state.customers.values()].filter(
        (c) => c.tenantId === tenantId,
      );
      expect(createdForTenant).toHaveLength(1);
    });

    it("portal returns a management URL (R9.2)", async () => {
      const { token } = await owner("Portal Co", "portal@x.test");
      const res = await app.inject({
        method: "POST",
        url: "/v1/billing/portal",
        headers: { authorization: `Bearer ${token}` },
        payload: { return_url: "https://app.test/account" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().portal_url).toBe("https://portal.test/session");
    });

    it("webhook syncs subscription state via API refetch and is idempotent (R10.3, R10.4)", async () => {
      const { tenantId, token } = await owner("Hook Co", "hook@x.test");
      // Establish the Stripe customer for this tenant so the webhook can map it.
      await app.inject({
        method: "POST",
        url: "/v1/billing/checkout",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          price_id: "price_pro",
          success_url: "https://app.test/ok",
          cancel_url: "https://app.test/no",
        },
      });
      // Point the mock subscription's customer at THIS tenant's customer id.
      const cust = await ownerPool.query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM organizations WHERE id = $1`,
        [tenantId],
      );
      stripe.state.subscription.customerId = cust.rows[0]!.stripe_customer_id;
      stripe.state.subscription.status = "active";
      stripe.state.subscription.items.plan = "pro";
      stripe.state.subscription.id = "sub_hook";

      const event = {
        id: "evt_sync_1",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_hook" } },
      };
      const send = () =>
        app.inject({
          method: "POST",
          url: "/webhooks/stripe",
          headers: { "stripe-signature": "test", "content-type": "application/json" },
          payload: JSON.stringify(event),
        });

      const first = await send();
      expect(first.statusCode).toBe(200);
      expect(first.json().outcome).toBe("processed");

      // Redelivery of the SAME event id → duplicate no-op (R10.3).
      const second = await send();
      expect(second.statusCode).toBe(200);
      expect(second.json().outcome).toBe("duplicate");

      // State synced: organizations.plan = pro.
      const org = await ownerPool.query<{ plan: string }>(
        `SELECT plan FROM organizations WHERE id = $1`,
        [tenantId],
      );
      expect(org.rows[0]!.plan).toBe("pro");
    });

    it("invoice.payment_failed drives the tenant to past_due (R10.6)", async () => {
      const { tenantId, token } = await owner("Fail Co", "fail@x.test");
      await app.inject({
        method: "POST",
        url: "/v1/billing/checkout",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          price_id: "price_pro",
          success_url: "https://app.test/ok",
          cancel_url: "https://app.test/no",
        },
      });
      const cust = await ownerPool.query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM organizations WHERE id = $1`,
        [tenantId],
      );
      stripe.state.subscription.customerId = cust.rows[0]!.stripe_customer_id;
      stripe.state.subscription.status = "past_due";
      stripe.state.subscription.id = "sub_fail";

      const event = {
        id: "evt_fail_1",
        type: "invoice.payment_failed",
        data: { object: { subscription: "sub_fail" } },
      };
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "stripe-signature": "test", "content-type": "application/json" },
        payload: JSON.stringify(event),
      });
      expect(res.statusCode).toBe(200);

      const sub = await ownerPool.query<{ status: string }>(
        `SELECT status FROM subscriptions WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [tenantId],
      );
      expect(sub.rows[0]!.status).toBe("past_due");
    });

    it("rejects a forged webhook signature with 400 (R10.2)", async () => {
      stripe.gw.constructEvent = vi.fn(() => {
        throw new Error("bad signature");
      });
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "stripe-signature": "bad", "content-type": "application/json" },
        payload: JSON.stringify({ id: "evt_x", type: "customer.subscription.updated", data: { object: {} } }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  if (!hasDocker) {
    it.skip("integration tests skipped — Docker daemon not reachable", () => {});
  }
});
