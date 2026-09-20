import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { PoolClient } from "pg";
import { errors } from "../../errors";
import type { SubStatus } from "../../billing/enforcement.service";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "../../projects/projects.service";
import {
  createProjectBody,
  listQuery,
  projectParams,
  updateProjectBody,
} from "./projects.schemas";
import "../../middleware/types";

export interface ProjectsRoutesOptions extends FastifyPluginOptions {
  authenticate: preHandlerAsyncHookHandler;
  tenantRateLimit?: preHandlerAsyncHookHandler | undefined;
  /** Plan enforcement (R11.1/R21): resolves billing state + quota. Optional. */
  enforcement?:
    | {
        getBillingState: (tenantId: string) => Promise<{ status: SubStatus; plan: string }>;
        assertWriteAllowed: (status: SubStatus) => void;
        assertProjectQuota: (db: PoolClient, plan: string) => Promise<void>;
      }
    | undefined;
  withTenant: {
    open: preHandlerAsyncHookHandler;
    commit: (req: never, reply: never, payload: unknown) => Promise<unknown>;
    onError: (req: never) => Promise<void>;
  };
}

/** /v1/projects CRUD (R8). Every route runs auth → rate-limit → withTenant so req.db is tenant-scoped. */
export async function projectsRoutes(
  app: FastifyInstance,
  opts: ProjectsRoutesOptions,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Order: authenticate → (rate limit) → withTenant. Rate-limited requests never open a txn.
  const preHandler = [
    opts.authenticate,
    ...(opts.tenantRateLimit ? [opts.tenantRateLimit] : []),
    opts.withTenant.open,
  ];

  // Commit the tenant transaction before the response is flushed; roll back on error.
  app.addHook("onSend", opts.withTenant.commit as never);
  app.addHook("onError", opts.withTenant.onError as never);

  const actor = (req: { auth?: { tenantId: string; userId: string } }) => {
    if (!req.auth) throw errors.noTenant();
    return { tenantId: req.auth.tenantId, userId: req.auth.userId };
  };

  r.post("/", { preHandler, schema: { body: createProjectBody } }, async (req, reply) => {
    const a = actor(req);
    if (opts.enforcement) {
      const billing = await opts.enforcement.getBillingState(a.tenantId);
      opts.enforcement.assertWriteAllowed(billing.status); // R11.1 (402 if past_due/canceled)
      await opts.enforcement.assertProjectQuota(req.db!, billing.plan); // R21 (403 QUOTA_EXCEEDED)
    }
    const row = await createProject(req.db!, a, req.body);
    return reply.code(201).send(row);
  });

  r.get("/", { preHandler, schema: { querystring: listQuery } }, async (req) => {
    return listProjects(req.db!, { cursor: req.query.cursor, limit: req.query.limit });
  });

  r.get("/:id", { preHandler, schema: { params: projectParams } }, async (req) => {
    return getProject(req.db!, req.params.id);
  });

  r.patch(
    "/:id",
    { preHandler, schema: { params: projectParams, body: updateProjectBody } },
    async (req) => {
      const a = actor(req);
      if (opts.enforcement) {
        const billing = await opts.enforcement.getBillingState(a.tenantId);
        opts.enforcement.assertWriteAllowed(billing.status);
      }
      return updateProject(req.db!, a, req.params.id, req.body);
    },
  );

  r.delete("/:id", { preHandler, schema: { params: projectParams } }, async (req, reply) => {
    const a = actor(req);
    if (opts.enforcement) {
      const billing = await opts.enforcement.getBillingState(a.tenantId);
      opts.enforcement.assertWriteAllowed(billing.status);
    }
    await deleteProject(req.db!, a, req.params.id);
    return reply.code(204).send();
  });
}
