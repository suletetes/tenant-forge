import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../../errors";
import { requireRole, type Role } from "../../auth/rbac";
import { createApiKey, listApiKeys, revokeApiKey } from "../../apikeys/apikey.service";
import "../../middleware/types";

export interface ApiKeyRoutesOptions extends FastifyPluginOptions {
  authenticate: preHandlerAsyncHookHandler;
  withTenant: {
    open: preHandlerAsyncHookHandler;
    commit: (req: never, reply: never, payload: unknown) => Promise<unknown>;
    onError: (req: never) => Promise<void>;
  };
}

const createBody = z.object({ name: z.string().min(1).max(120) });
const keyParams = z.object({ id: z.string().uuid() });

/** /v1/api-keys (R5). Owner/admin only, tenant-scoped. */
export async function apiKeyRoutes(app: FastifyInstance, opts: ApiKeyRoutesOptions): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.addHook("onSend", opts.withTenant.commit as never);
  app.addHook("onError", opts.withTenant.onError as never);
  const pre = [opts.authenticate, opts.withTenant.open];

  const actor = (req: { auth?: { tenantId: string; userId: string; role: string } }) => {
    if (!req.auth) throw errors.unauthorized();
    requireRole(req.auth.role as Role, "admin");
    return { tenantId: req.auth.tenantId, userId: req.auth.userId };
  };

  r.post("/", { preHandler: pre, schema: { body: createBody } }, async (req, reply) => {
    const created = await createApiKey(req.db!, actor(req), req.body.name);
    // Plaintext key returned exactly once (R5.1).
    return reply.code(201).send({ id: created.id, api_key: created.key });
  });

  r.get("/", { preHandler: pre }, async (req) => {
    return { data: await listApiKeys(req.db!) };
  });

  r.delete("/:id", { preHandler: pre, schema: { params: keyParams } }, async (req, reply) => {
    await revokeApiKey(req.db!, actor(req), req.params.id);
    return reply.code(204).send();
  });
}
