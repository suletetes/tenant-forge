import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { z } from "zod";
import { errors } from "../../errors";
import { requireRole, type Role } from "../../auth/rbac";
import { openPortal, startCheckout } from "../../billing/billing.service";
import type { StripeGateway } from "../../billing/stripe.gateway";
import "../../middleware/types";

export interface BillingRoutesOptions extends FastifyPluginOptions {
  ownerPool: Pool;
  stripe: StripeGateway;
  authenticate: preHandlerAsyncHookHandler;
  /** Allow-list of valid checkout price IDs. Empty → checkout is blocked (fail closed). */
  allowedPriceIds: string[];
  /** Allow-list of valid redirect origins. Empty → any URL is accepted (backwards-compatible). */
  allowedRedirectOrigins: string[];
}

const checkoutBody = z.object({
  price_id: z.string().min(1),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});
const portalBody = z.object({ return_url: z.string().url() });

/** True if `rawUrl` is a valid URL whose origin is in `allowed`. Empty allow-list → always true. */
function isAllowedRedirect(rawUrl: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  let origin: string;
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    return false;
  }
  return allowed.includes(origin);
}

/** /v1/billing routes (R9). Authenticated; owner/admin only (billing is a privileged action). */
export async function billingRoutes(
  app: FastifyInstance,
  opts: BillingRoutesOptions,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  function requireBillingRole(req: { auth?: { role: string; tenantId: string } }): string {
    if (!req.auth) throw errors.unauthorized();
    requireRole(req.auth.role as Role, "admin");
    return req.auth.tenantId;
  }

  r.post(
    "/checkout",
    { preHandler: opts.authenticate, schema: { body: checkoutBody } },
    async (req, reply) => {
      const tenantId = requireBillingRole(req);
      // Reject unknown prices so a caller cannot subscribe to a price that maps to no plan (R9.3).
      if (!opts.allowedPriceIds.includes(req.body.price_id)) {
        throw errors.badRequest("Unknown price_id");
      }
      // Reject off-origin redirects (open-redirect protection).
      if (
        !isAllowedRedirect(req.body.success_url, opts.allowedRedirectOrigins) ||
        !isAllowedRedirect(req.body.cancel_url, opts.allowedRedirectOrigins)
      ) {
        throw errors.badRequest("Redirect URL origin not allowed");
      }
      const result = await startCheckout(opts.ownerPool, opts.stripe, {
        tenantId,
        priceId: req.body.price_id,
        successUrl: req.body.success_url,
        cancelUrl: req.body.cancel_url,
      });
      return reply.code(201).send({ checkout_url: result.url, session_id: result.sessionId });
    },
  );

  r.post(
    "/portal",
    { preHandler: opts.authenticate, schema: { body: portalBody } },
    async (req, reply) => {
      const tenantId = requireBillingRole(req);
      if (!isAllowedRedirect(req.body.return_url, opts.allowedRedirectOrigins)) {
        throw errors.badRequest("Redirect URL origin not allowed");
      }
      const result = await openPortal(opts.ownerPool, opts.stripe, {
        tenantId,
        returnUrl: req.body.return_url,
      });
      return reply.code(201).send({ portal_url: result.url });
    },
  );
}
