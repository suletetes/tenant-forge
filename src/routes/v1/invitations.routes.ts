import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { errors } from "../../errors";
import { createInvitation, changeRole } from "../../team/team.service";
import type { Role } from "../../auth/rbac";
import { inviteBody } from "./auth.schemas";
import { z } from "zod";
import "../../middleware/types";

export interface InvitationRoutesOptions extends FastifyPluginOptions {
  ownerPool: Pool;
  authenticate: preHandlerAsyncHookHandler;
}

const roleChangeBody = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["owner", "admin", "member"]),
});

/** Authenticated team-management routes (R20). Invite + role change require owner/admin. */
export async function invitationRoutes(
  app: FastifyInstance,
  opts: InvitationRoutesOptions,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/", { preHandler: opts.authenticate, schema: { body: inviteBody } }, async (req, reply) => {
    if (!req.auth) throw errors.unauthorized();
    const { token } = await createInvitation(
      opts.ownerPool,
      { tenantId: req.auth.tenantId, userId: req.auth.userId, role: req.auth.role as Role },
      req.body,
    );
    // Token emailed in production; returned here so the flow is demoable in dev/tests.
    return reply.code(201).send({ status: "invited", invitation_token: token });
  });

  r.post(
    "/role",
    { preHandler: opts.authenticate, schema: { body: roleChangeBody } },
    async (req, reply) => {
      if (!req.auth) throw errors.unauthorized();
      await changeRole(
        opts.ownerPool,
        { tenantId: req.auth.tenantId, userId: req.auth.userId, role: req.auth.role as Role },
        req.body.user_id,
        req.body.role,
      );
      return reply.code(200).send({ status: "ok" });
    },
  );
}
