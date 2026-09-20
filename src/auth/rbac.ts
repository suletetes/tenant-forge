import { errors } from "../errors";

/** Org-scoped roles with precedence owner > admin > member (R4.1). */
export type Role = "owner" | "admin" | "member";

const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/** True if `role` meets or exceeds `min` in the hierarchy (R4.2). */
export function hasMinRole(role: Role, min: Role): boolean {
  return (RANK[role] ?? 0) >= RANK[min];
}

/** Throws 403 unless `role` meets `min` (R4.3). Central enforcement point for all routes. */
export function requireRole(role: Role, min: Role): void {
  if (!hasMinRole(role, min)) throw errors.forbidden();
}
