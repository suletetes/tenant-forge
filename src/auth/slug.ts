import { randomBytes } from "node:crypto";

/**
 * Generates a URL-safe org slug from a name plus a short random suffix for uniqueness (R1.3).
 * The DB unique index on organizations.slug is the final arbiter; callers retry on conflict.
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = randomBytes(3).toString("hex"); // 6 hex chars
  return base ? `${base}-${suffix}` : `org-${suffix}`;
}
