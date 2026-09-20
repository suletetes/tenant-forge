import { describe, expect, it } from "vitest";
import { hasMinRole, requireRole } from "../../src/auth/rbac";
import { AppError } from "../../src/errors";

describe("RBAC hasMinRole (R4.1, R4.2)", () => {
  it("owner meets every minimum", () => {
    expect(hasMinRole("owner", "owner")).toBe(true);
    expect(hasMinRole("owner", "admin")).toBe(true);
    expect(hasMinRole("owner", "member")).toBe(true);
  });
  it("admin meets admin+member but not owner", () => {
    expect(hasMinRole("admin", "owner")).toBe(false);
    expect(hasMinRole("admin", "admin")).toBe(true);
    expect(hasMinRole("admin", "member")).toBe(true);
  });
  it("member meets only member", () => {
    expect(hasMinRole("member", "owner")).toBe(false);
    expect(hasMinRole("member", "admin")).toBe(false);
    expect(hasMinRole("member", "member")).toBe(true);
  });
  it("requireRole throws 403 when below minimum (R4.3)", () => {
    let err: unknown;
    try {
      requireRole("member", "admin");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
    expect(() => requireRole("admin", "admin")).not.toThrow();
  });
});
