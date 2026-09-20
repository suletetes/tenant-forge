import { describe, expect, it, vi } from "vitest";
import { changeRole, createInvitation } from "../../src/team/team.service";
import { requestPasswordReset } from "../../src/auth/password-reset.service";
import { AppError } from "../../src/errors";

/** Fake pool whose client answers scripted queries; records SQL verbs. */
function fakePool(onQuery: (sql: string) => unknown) {
  const client = {
    query: vi.fn(async (sql: string) => onQuery(sql)),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => onQuery(sql)),
  };
  return { pool: pool as never, client };
}

describe("Task 6b — RBAC guards (R20)", () => {
  it("forbids a member from creating an invitation (R20.2)", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const err = await createInvitation(
      pool,
      { tenantId: "t1", userId: "u1", role: "member" },
      { email: "x@y.test", role: "member" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
  });

  it("blocks demoting the last owner with 409 (R20.6)", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("SELECT role FROM users")) return { rows: [{ role: "owner" }] };
      if (sql.includes("count(*)")) return { rows: [{ n: 1 }] }; // only one owner
      return { rows: [] };
    });
    const err = await changeRole(
      pool,
      { tenantId: "t1", userId: "u1", role: "owner" },
      "target",
      "member",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
  });

  it("allows demoting an owner when another owner remains", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("SELECT role FROM users")) return { rows: [{ role: "owner" }] };
      if (sql.includes("count(*)")) return { rows: [{ n: 2 }] };
      return { rows: [] };
    });
    await expect(
      changeRole(pool, { tenantId: "t1", userId: "u1", role: "owner" }, "target", "member"),
    ).resolves.toBeUndefined();
  });
});

describe("Task 6b — password reset no-enumeration (R22.1)", () => {
  it("returns a null token (no work) when the email does not exist", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("FROM users")) return { rows: [] }; // unknown email
      return { rows: [] };
    });
    const res = await requestPasswordReset(pool, "ghost@nowhere.test");
    expect(res.token).toBeNull();
  });

  it("issues a token when the email maps to a user", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("FROM users")) return { rows: [{ id: "u1", tenant_id: "t1" }] };
      return { rows: [] };
    });
    const res = await requestPasswordReset(pool, "real@user.test");
    expect(res.token).toBeTruthy();
  });
});
