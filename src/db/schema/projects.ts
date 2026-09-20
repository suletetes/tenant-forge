import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * projects — the demonstration tenant-scoped resource (RLS enforced, R8).
 * tenant_id leads the composite index (NFR2.2).
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("projects_tenant_created_idx").on(t.tenantId, t.createdAt)],
);
