import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errors } from "../../errors";
import { createProject, getProject, listProjects } from "../../projects/projects.service";
import { createProjectBody, listQuery, projectParams } from "../v1/projects.schemas";
import "../../middleware/types";

export interface ProjectsV2Options extends FastifyPluginOptions {
  authenticate: preHandlerAsyncHookHandler;
  withTenant: {
    open: preHandlerAsyncHookHandler;
    commit: (req: never, reply: never, payload: unknown) => Promise<unknown>;
    onError: (req: never) => Promise<void>;
  };
}

/**
 * /v2/projects (R13.2). Demonstrates the versioning strategy with a DELIBERATE BREAKING CHANGE
 * vs /v1 while /v1 stays frozen:
 *   - List envelope: v1 `{ data, next_cursor }` → v2 `{ items, page: { next_cursor, limit } }`.
 *   - Resource field: v1 `created_at` (snake) → v2 `createdAt` (camel).
 * Same underlying service; only the response contract differs.
 */
function toV2(row: {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at, // renamed field (breaking)
  };
}

export async function projectsV2Routes(
  app: FastifyInstance,
  opts: ProjectsV2Options,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = [opts.authenticate, opts.withTenant.open];
  app.addHook("onSend", opts.withTenant.commit as never);
  app.addHook("onError", opts.withTenant.onError as never);

  const actor = (req: { auth?: { tenantId: string; userId: string } }) => {
    if (!req.auth) throw errors.noTenant();
    return { tenantId: req.auth.tenantId, userId: req.auth.userId };
  };

  r.post("/", { preHandler, schema: { body: createProjectBody } }, async (req, reply) => {
    const row = await createProject(req.db!, actor(req), req.body);
    return reply.code(201).send(toV2(row)); // camelCase createdAt
  });

  r.get("/", { preHandler, schema: { querystring: listQuery } }, async (req) => {
    const result = await listProjects(req.db!, { cursor: req.query.cursor, limit: req.query.limit });
    // Breaking pagination envelope.
    return {
      items: result.data.map(toV2),
      page: { next_cursor: result.next_cursor, limit: req.query.limit },
    };
  });

  r.get("/:id", { preHandler, schema: { params: projectParams } }, async (req) => {
    return toV2(await getProject(req.db!, req.params.id));
  });
}
