import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { errors } from "../../errors";
import { requireRole, type Role } from "../../auth/rbac";
import { cancelTenant } from "../../tenants/lifecycle.service";
import "../../middleware/types";

export interface TenantRoutesOptions extends FastifyPluginOptions {
  ownerPool: Pool;
  authenticate: preHandlerAsyncHookHandler;
}

/**
 * /v1/tenant lifecycle (R2). Cancel is owner-only and soft-deletes the org + revokes sessions.
 * Runs on the owner pool (the tenant is being removed; not a normal RLS request path).
 */
export async function tenantRoutes(app: FastifyInstance, opts: TenantRoutesOptions): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.delete("/", { preHandler: opts.authenticate }, async (req, reply) => {
    if (!req.auth) throw errors.unauthorized();
    requireRole(req.auth.role as Role, "owner"); // only an owner may cancel the org (R2.1)
    await cancelTenant(opts.ownerPool, { tenantId: req.auth.tenantId, userId: req.auth.userId });
    return reply.code(204).send();
  });
}
