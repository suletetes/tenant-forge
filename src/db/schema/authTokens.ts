import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * auth_tokens — tenant-scoped (RLS enforced, R22). Single-use password-reset / email-verify
 * tokens; stored hashed only.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(), // password_reset | email_verify
    hashedToken: text("hashed_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("auth_tokens_hash_uniq").on(t.hashedToken),
    index("auth_tokens_tenant_user_type_idx").on(t.tenantId, t.userId, t.type),
  ],
);
