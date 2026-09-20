export { organizations } from "./organizations";
export { users } from "./users";
export { projects } from "./projects";
export { auditLog } from "./auditLog";
export { refreshTokens } from "./refreshTokens";
export { invitations } from "./invitations";
export { authTokens } from "./authTokens";
export { subscriptions } from "./subscriptions";
export { processedWebhooks } from "./processedWebhooks";
export { apiKeys } from "./apiKeys";

/**
 * Table registry (design §3.2). Single source of truth for which tables are tenant-scoped
 * (carry a `tenant_id` + RLS policy) vs global. Consumed by:
 *  - the RLS migration generator (ENABLE + FORCE + policy per scoped table),
 *  - the CI schema lint (any table absent from both lists fails CI, Task 8),
 *  - the tenant data-export job (R24) and tenant-purge job.
 *
 * When adding a table, add it to exactly one of these lists.
 */
export const TENANT_SCOPED_TABLES = [
  "users",
  "projects",
  "audit_log",
  "refresh_tokens",
  "invitations",
  "auth_tokens",
  "subscriptions",
  "api_keys",
] as const;

export const GLOBAL_TABLES = [
  "organizations",
  "processed_webhooks",
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];
