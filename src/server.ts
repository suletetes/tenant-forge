import { Pool } from "pg";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { RateLimiter } from "./ratelimit/limiter";
import { RealStripeGateway } from "./billing/stripe.gateway";

const config = loadConfig();
// Owner/migrator pool for tenant-provisioning routes (signup). App-role pool is used by
// tenant-scoped routes (added in Task 5/6).
const ownerPool = new Pool({
  connectionString: config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
  max: 5,
});
// App-role pool (NOBYPASSRLS) for tenant-scoped routes.
const appPool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });

// Optional Redis-backed rate limiter (R12/R23).
let rateLimiter: RateLimiter | undefined;
if (config.REDIS_URL) {
  rateLimiter = new RateLimiter(new Redis(config.REDIS_URL));
}

// Optional Stripe gateway (R9/R10) — test-mode keys from Secrets Manager in real envs.
let stripe: RealStripeGateway | undefined;
if (config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET) {
  stripe = new RealStripeGateway(config.STRIPE_SECRET_KEY, config.STRIPE_WEBHOOK_SECRET);
}

const app = buildApp(config, { ownerPool, appPool, rateLimiter, stripe });

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .then((address) => {
    app.log.info({ address }, "TenantForge API listening");
  })
  .catch((err) => {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  });

// Graceful shutdown for ECS task draining.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}
