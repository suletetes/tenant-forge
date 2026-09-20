import { z } from "zod";

/**
 * Environment configuration, validated once at boot (NFR1.2).
 * Secrets are read from the environment (injected from Secrets Manager in AWS, R17.4)
 * and never logged.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),

  JWT_SIGNING_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1_209_600),

  REDIS_URL: z.string().optional(),

  CORS_ORIGIN: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  /**
   * Comma-separated allow-list of Stripe price IDs a tenant may check out against (R9.1/R9.3).
   * Checkout rejects any price_id not in this set, so a caller cannot subscribe to an unknown
   * price that maps to no plan. Parsed into STRIPE_PRICE_ID_LIST below.
   */
  STRIPE_PRICE_IDS: z.string().optional(),
  /**
   * Comma-separated allow-list of origins (scheme://host[:port]) permitted as checkout/portal
   * redirect targets. Prevents open-redirect to attacker-controlled domains. Parsed into
   * BILLING_REDIRECT_ORIGIN_LIST below.
   */
  BILLING_REDIRECT_ORIGINS: z.string().optional(),
});

/** Splits a comma-separated env string into a trimmed, non-empty list. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type AppConfig = z.infer<typeof envSchema> & {
  /**
   * Parsed allow-list of valid checkout price IDs. Optional on the type (so lightweight config
   * literals in tests need not set it); always populated by loadConfig. Consumers treat an
   * absent/empty list as "allow none" (checkout blocked — fail closed).
   */
  STRIPE_PRICE_ID_LIST?: string[];
  /**
   * Parsed allow-list of valid redirect origins. Optional on the type; always populated by
   * loadConfig. Consumers treat an absent/empty list as "allow any" (backwards-compatible).
   */
  BILLING_REDIRECT_ORIGIN_LIST?: string[];
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Print keys only — never values — to avoid leaking secrets.
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${missing}`);
  }
  return {
    ...parsed.data,
    STRIPE_PRICE_ID_LIST: splitList(parsed.data.STRIPE_PRICE_IDS),
    BILLING_REDIRECT_ORIGIN_LIST: splitList(parsed.data.BILLING_REDIRECT_ORIGINS),
  };
}
