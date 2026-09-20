import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * audit_log — tenant-scoped (RLS enforced, R16). Records security/billing-significant actions.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt)],
);
