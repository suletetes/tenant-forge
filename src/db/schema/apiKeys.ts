import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * api_keys — tenant-scoped (RLS enforced, R5). Only the hash is stored; the plaintext key is
 * returned to the caller exactly once at creation. Revoked keys keep a `revoked_at` timestamp.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    hashedKey: text("hashed_key").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("api_keys_hash_uniq").on(t.hashedKey),
    index("api_keys_tenant_idx").on(t.tenantId, t.revokedAt),
  ],
);
