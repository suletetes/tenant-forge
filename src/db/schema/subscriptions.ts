import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * subscriptions — tenant-scoped (RLS enforced, R9). Mirrors the Stripe subscription; status
 * drives the degraded-access matrix (R11.1). Synced from webhooks via API refetch (R10.4).
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status").notNull().default("active"), // active|past_due|canceled|trialing
    plan: text("plan").notNull().default("free"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("subscriptions_stripe_id_uniq").on(t.stripeSubscriptionId),
    index("subscriptions_tenant_status_idx").on(t.tenantId, t.status),
  ],
);
