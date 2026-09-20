import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * processed_webhooks — GLOBAL idempotency ledger (design §3.2, R10.3). NOT tenant-scoped: keyed
 * by the Stripe event id. Inserting the event id BEFORE business logic; a unique-violation is
 * the dedup signal that makes webhook redelivery a safe no-op.
 */
export const processedWebhooks = pgTable("processed_webhooks", {
  eventId: text("event_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
});
