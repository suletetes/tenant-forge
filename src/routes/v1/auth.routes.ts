import type { FastifyInstance, FastifyPluginOptions, preHandlerAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { signup } from "../../auth/signup.service";
import { login } from "../../auth/login.service";
import {
  requestPasswordReset,
  confirmPasswordReset,
} from "../../auth/password-reset.service";
import { acceptInvitation } from "../../team/team.service";
import { rotateRefreshToken } from "../../auth/refresh.service";
import type { TokenService } from "../../auth/token.service";
import {
  acceptInviteBody,
  loginBody,
  refreshBody,
  resetConfirmBody,
  resetRequestBody,
  signupBody,
} from "./auth.schemas";

export interface AuthRoutesOptions extends FastifyPluginOptions {
  /** Owner/migrator pool — signup provisions the tenant so it runs outside tenant RLS. */
  ownerPool: Pool;
  tokens: TokenService;
  /** Pre-auth IP limiters (R23): stricter on credential routes. Optional. */
  ipCredentialLimit?: preHandlerAsyncHookHandler | undefined;
  ipGeneralLimit?: preHandlerAsyncHookHandler | undefined;
}

/**
 * /v1/auth routes. Registered under the /v1 prefix (R13.1).
 * Task 3: signup. Task 4: login. Task 6b: password reset + invitations. Task 15a: refresh.
 */
export async function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const credential = opts.ipCredentialLimit ? [opts.ipCredentialLimit] : [];
  const general = opts.ipGeneralLimit ? [opts.ipGeneralLimit] : [];

  r.post(
    "/signup",
    { preHandler: general, schema: { body: signupBody } },
    async (req, reply) => {
      const result = await signup(opts.ownerPool, req.body);
      req.log.info({ tenantId: result.organizationId }, "org.created");
      return reply.code(201).send({
        organization_id: result.organizationId,
        owner_user_id: result.ownerUserId,
        slug: result.slug,
      });
    },
  );

  r.post(
    "/login",
    { preHandler: credential, schema: { body: loginBody } },
    async (req, reply) => {
      const result = await login(opts.ownerPool, opts.tokens, req.body);
      return reply.code(200).send({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: "Bearer" as const,
      });
    },
  );

  // Password reset (R22) — unauthenticated. Request never reveals whether the email exists.
  r.post(
    "/password-reset/request",
    { preHandler: credential, schema: { body: resetRequestBody } },
    async (req, reply) => {
      const { token } = await requestPasswordReset(opts.ownerPool, req.body.email);
      if (token) req.log.info("password reset token issued");
      return reply.code(202).send({ status: "accepted" });
    },
  );

  r.post("/password-reset/confirm", { schema: { body: resetConfirmBody } }, async (req, reply) => {
    await confirmPasswordReset(opts.ownerPool, {
      token: req.body.token,
      newPassword: req.body.new_password,
    });
    return reply.code(200).send({ status: "ok" });
  });

  // Invitation acceptance (R20.3) — unauthenticated (the invitee has no account yet).
  r.post("/invitations/accept", { schema: { body: acceptInviteBody } }, async (req, reply) => {
    const result = await acceptInvitation(opts.ownerPool, req.body);
    return reply.code(201).send({ user_id: result.userId, tenant_id: result.tenantId });
  });

  // Refresh-token rotation with reuse detection (R3.3, R3.4, R3.6).
  r.post("/refresh", { preHandler: credential, schema: { body: refreshBody } }, async (req, reply) => {
    const result = await rotateRefreshToken(opts.ownerPool, opts.tokens, req.body.refresh_token);
    return reply.code(200).send({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      token_type: "Bearer" as const,
    });
  });
}
