import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { Pool } from "pg";
import type { AppConfig } from "./config";
import { AppError, toEnvelope } from "./errors";
import { TokenService } from "./auth/token.service";
import { authRoutes } from "./routes/v1/auth.routes";
import { invitationRoutes } from "./routes/v1/invitations.routes";
import { projectsRoutes } from "./routes/v1/projects.routes";
import { projectsV2Routes } from "./routes/v2/projects.routes";
import { exportRoutes } from "./routes/v1/export.routes";
import { apiKeyRoutes } from "./routes/v1/apikey.routes";
import { tenantRoutes } from "./routes/v1/tenant.routes";
import { billingRoutes } from "./routes/v1/billing.routes";
import { webhookRoutes } from "./routes/webhook.routes";
import type { StripeGateway } from "./billing/stripe.gateway";
import { makeAuthenticate, makeWithTenant } from "./middleware/tenant";
import type { RateLimiter } from "./ratelimit/limiter";
import { makeTenantRateLimiter, makeIpRateLimiter } from "./ratelimit/middleware";
import {
  assertProjectQuota,
  assertWriteAllowed,
  getBillingState,
} from "./billing/enforcement.service";

export interface AppDeps {
  /** Owner/migrator pool for signup provisioning (tenant-creating, pre-RLS-context). */
  ownerPool?: Pool;
  /** App-role pool (NOBYPASSRLS) for tenant-scoped routes. */
  appPool?: Pool;
  /** Optional Redis-backed rate limiter (R12/R23). When absent, limiting is skipped. */
  rateLimiter?: RateLimiter | undefined;
  /** Optional Stripe gateway (R9/R10). When absent, billing + webhook routes are not registered. */
  stripe?: StripeGateway | undefined;
}

/**
 * Builds the Fastify app.
 * - Structured JSON logs from day one (R15.1) via pino (Fastify's default logger).
 * - Per-request correlation id `request_id` generated in onRequest and echoed back (R15.2).
 * - Zod as the single validation/serialization source of truth (R14.1).
 * - Central error handler enforcing the consistent envelope (R14.4, R14.5).
 */
export function buildApp(config: AppConfig, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Redact anything that could carry secrets/tokens (R15.5, R3.7).
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token"],
        censor: "[REDACTED]",
      },
    },
    // Use our own correlation id as Fastify's reqId so every log line carries it.
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? randomUUID(),
    // Derive req.ip from the ALB/CloudFront forwarded header, not a raw client header (R23.5).
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod validation + serialization (R14.1).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // OpenAPI 3.1 generation from Zod schemas + Swagger UI (R14.2). Registered before routes so
  // every subsequently-registered route is captured. Served at /docs; the spec at /openapi.json.
  void app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "TenantForge API", version: "1.0.0" },
      servers: [{ url: "/" }],
    },
    transform: jsonSchemaTransform,
  });
  void app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  // Attach request_id to the log context and response headers (R15.2).
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  // Minimal CORS for the admin SPA (Task 22). Origin is configurable via CORS_ORIGIN; rate-limit
  // headers are exposed so the browser client can display them. No credentials mode (Bearer only).
  // Production should set a specific origin — a wildcard is flagged below (NFR1).
  const corsOrigin = config.CORS_ORIGIN ?? "*";
  if (config.NODE_ENV === "production" && corsOrigin === "*") {
    app.log.warn("CORS_ORIGIN is '*' in production — set a specific origin to harden (NFR1)");
  }
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", corsOrigin);
    reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "authorization,content-type,x-request-id");
    reply.header(
      "access-control-expose-headers",
      "x-request-id,x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset,retry-after",
    );
    if (req.method === "OPTIONS") {
      reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }
  });

  // Health check (Task 1). Intentionally unauthenticated and un-rate-limited.
  app.get("/health", async () => ({ status: "ok" }));

  // Machine-readable OpenAPI spec (R14.2). @fastify/swagger builds it from the Zod route schemas.
  app.get("/openapi.json", async () => app.swagger());

  // v1 routes (registered when their dependencies are provided).
  if (deps.ownerPool) {
    const ownerPool = deps.ownerPool;
    const tokens = new TokenService({
      signingSecret: config.JWT_SIGNING_SECRET,
      accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
    });
    // Pre-auth IP limiters (R23): stricter on credential routes.
    const ipCredentialLimit = deps.rateLimiter
      ? makeIpRateLimiter(deps.rateLimiter, "credential")
      : undefined;
    const ipGeneralLimit = deps.rateLimiter
      ? makeIpRateLimiter(deps.rateLimiter, "general")
      : undefined;
    app.register(
      (instance) => authRoutes(instance, { ownerPool, tokens, ipCredentialLimit, ipGeneralLimit }),
      { prefix: "/v1/auth" },
    );

    const authenticateForInvites = makeAuthenticate(tokens);
    app.register(
      (instance) => invitationRoutes(instance, { ownerPool, authenticate: authenticateForInvites }),
      { prefix: "/v1/invitations" },
    );

    // Tenant-scoped routes require the app-role pool + tenant middleware.
    if (deps.appPool) {
      const appPool = deps.appPool;
      const authenticate = makeAuthenticate(tokens, ownerPool);
      const withTenant = makeWithTenant(appPool);
      // Per-tenant rate limiter (R12): plan resolved from organizations.plan on the owner pool.
      const planOf = async (tenantId: string): Promise<string> => {
        const res = await ownerPool.query<{ plan: string }>(
          `SELECT plan FROM organizations WHERE id = $1`,
          [tenantId],
        );
        return res.rows[0]?.plan ?? "free";
      };
      const tenantRateLimit = deps.rateLimiter
        ? makeTenantRateLimiter(deps.rateLimiter, planOf)
        : undefined;
      // Plan enforcement (R11.1 degraded-access matrix + R21 quotas).
      const enforcement = {
        getBillingState: (tenantId: string) => getBillingState(ownerPool, tenantId),
        assertWriteAllowed,
        assertProjectQuota,
      };
      app.register(
        (instance) =>
          projectsRoutes(instance, { authenticate, withTenant, tenantRateLimit, enforcement }),
        { prefix: "/v1/projects" },
      );

      // /v2 — same middleware, breaking response contract (R13.2). /v1 stays frozen.
      app.register((instance) => projectsV2Routes(instance, { authenticate, withTenant }), {
        prefix: "/v2/projects",
      });

      // Tenant data export (R24) — owner/admin, tenant-scoped.
      app.register((instance) => exportRoutes(instance, { authenticate, withTenant }), {
        prefix: "/v1/exports",
      });

      // API keys (R5) — owner/admin, tenant-scoped.
      app.register((instance) => apiKeyRoutes(instance, { authenticate, withTenant }), {
        prefix: "/v1/api-keys",
      });

      // Tenant lifecycle (R2) — owner-only cancel; runs on the owner pool.
      app.register((instance) => tenantRoutes(instance, { ownerPool, authenticate }), {
        prefix: "/v1/tenant",
      });

      // Billing routes (R9) — authenticated, owner/admin.
      if (deps.stripe) {
        const stripe = deps.stripe;
        app.register(
          (instance) =>
            billingRoutes(instance, {
              ownerPool,
              stripe,
              authenticate,
              allowedPriceIds: config.STRIPE_PRICE_ID_LIST ?? [],
              allowedRedirectOrigins: config.BILLING_REDIRECT_ORIGIN_LIST ?? [],
            }),
          { prefix: "/v1/billing" },
        );
      }
    }

    // Stripe webhook (R10) — its own plugin (raw body), no auth, rate-limit exempt.
    if (deps.stripe) {
      const stripe = deps.stripe;
      app.register((instance) => webhookRoutes(instance, { ownerPool, stripe }), {
        prefix: "/webhooks/stripe",
      });
    }
  }

  // Central error handler → consistent envelope, no internal leakage (R14.5).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      req.log.warn({ code: err.code, statusCode: err.statusCode }, "handled error");
      return reply.code(err.statusCode).send(toEnvelope(err.code, err.message, requestId));
    }
    if (err.validation) {
      req.log.warn({ validation: err.validation }, "validation error");
      return reply.code(400).send(toEnvelope("VALIDATION_FAILED", "Request validation failed", requestId));
    }
    // Unknown error: log internally with full detail, return generic message.
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(toEnvelope("INTERNAL", "Internal server error", requestId));
  });

  // Consistent 404 envelope for unmatched routes.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(toEnvelope("RESOURCE_NOT_FOUND", "Route not found", req.id));
  });

  return app;
}
