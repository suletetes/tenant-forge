import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * refresh_tokens — tenant-scoped (RLS enforced, R3). Stored as hashes only; `family_id`
 * groups a login chain so reuse can revoke the whole family (R3.4).
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    hashedToken: text("hashed_token").notNull(),
    familyId: uuid("family_id").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_hash_uniq").on(t.hashedToken),
    index("refresh_tokens_tenant_family_idx").on(t.tenantId, t.familyId),
  ],
);
