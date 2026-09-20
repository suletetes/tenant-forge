import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errors } from "../../errors";
import { requireRole, type Role } from "../../auth/rbac";
import { buildTenantExport } from "../../exports/export.service";
import "../../middleware/types";

export interface ExportRoutesOptions extends FastifyPluginOptions {
  authenticate: preHandlerAsyncHookHandler;
  withTenant: {
    open: preHandlerAsyncHookHandler;
    commit: (req: never, reply: never, payload: unknown) => Promise<unknown>;
    onError: (req: never) => Promise<void>;
  };
}

/**
 * /v1/exports (R24). Owner/admin only. Runs under the tenant-scoped connection so RLS bounds the
 * export to the caller's tenant. Writes an audit entry.
 */
export async function exportRoutes(
  app: FastifyInstance,
  opts: ExportRoutesOptions,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.addHook("onSend", opts.withTenant.commit as never);
  app.addHook("onError", opts.withTenant.onError as never);

  r.post("/", { preHandler: [opts.authenticate, opts.withTenant.open] }, async (req, reply) => {
    if (!req.auth) throw errors.unauthorized();
    requireRole(req.auth.role as Role, "admin");
    const archive = await buildTenantExport(req.db!);
    await req.db!.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, target)
       VALUES ($1,$2,'tenant.exported',$3)`,
      [req.auth.tenantId, req.auth.userId, req.auth.tenantId],
    );
    reply.header("content-disposition", 'attachment; filename="tenant-export.json"');
    return reply.code(200).send(archive);
  });
}
