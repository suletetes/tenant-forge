import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * organizations — the tenant root (global table, no RLS policy). Every tenant-scoped
 * `tenant_id` references this table's id (design §3.2).
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull().default("free"), // free | starter | pro
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("organizations_slug_uniq").on(t.slug),
    // One Stripe customer per organization. Partial (NOT NULL) so the many orgs without a
    // customer id are unconstrained. Backstop for the ensureCustomer row-lock race (R9.1).
    uniqueIndex("organizations_stripe_customer_uniq")
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} IS NOT NULL`),
  ],
);
