import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * invitations — tenant-scoped (RLS enforced, R20). Single-use, time-limited; token stored hashed.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull(),
    role: text("role").notNull(), // admin | member
    hashedToken: text("hashed_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("invitations_hash_uniq").on(t.hashedToken),
    index("invitations_tenant_email_idx").on(t.tenantId, t.email),
  ],
);
