import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { Pool } from "pg";
import type { StripeGateway } from "../billing/stripe.gateway";
import { processWebhookEvent } from "../billing/webhook.service";

export interface WebhookRoutesOptions extends FastifyPluginOptions {
  ownerPool: Pool;
  stripe: StripeGateway;
}

/**
 * Stripe webhook endpoint (R10). Registered as its own plugin so it can attach a RAW-body
 * content-type parser (signature verification needs the exact bytes). This route is EXEMPT from
 * rate limiting (R23.4) — it's unauthenticated and protected by signature verification instead.
 */
export async function webhookRoutes(
  app: FastifyInstance,
  opts: WebhookRoutesOptions,
): Promise<void> {
  // Capture the raw body for this plugin's routes only, with a size cap (Stripe events are small;
  // this bounds an oversized POST before signature verification runs).
  const MAX_WEBHOOK_BYTES = 1_048_576; // 1 MiB
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: MAX_WEBHOOK_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post("/", async (req, reply) => {
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string") {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "Missing signature" } });
    }
    let event: { id: string; type: string; data: { object: unknown } };
    try {
      event = opts.stripe.constructEvent(req.body as Buffer, sig); // verify (R10.1)
    } catch {
      // Invalid signature → 400, no state mutation (R10.2).
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "Invalid signature" } });
    }

    const outcome = await processWebhookEvent(opts.ownerPool, opts.stripe, event);
    req.log.info({ eventId: event.id, type: event.type, outcome }, "stripe webhook");
    // Always 200 on a verified event (incl. duplicates) so Stripe stops retrying (R10.3/R10.7).
    return reply.code(200).send({ received: true, outcome });
  });
}
