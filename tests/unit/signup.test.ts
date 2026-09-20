import { describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/password";
import { slugify } from "../../src/auth/slug";
import { signup } from "../../src/auth/signup.service";
import { AppError } from "../../src/errors";

describe("Task 3 — password hashing (R1.6)", () => {
  it("hashes to Argon2id, never returns plaintext, and verifies", async () => {
    const hash = await hashPassword("s3cret-pw");
    expect(hash).not.toContain("s3cret-pw");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "s3cret-pw")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });
});

describe("Task 3 — slug generation (R1.3)", () => {
  it("produces a url-safe slug with a random suffix", () => {
    const s = slugify("Acme, Inc.");
    expect(s).toMatch(/^acme-inc-[0-9a-f]{6}$/);
  });

  it("falls back to org- prefix for empty/non-alnum names", () => {
    expect(slugify("!!!")).toMatch(/^org-[0-9a-f]{6}$/);
  });

  it("generates distinct slugs for the same name", () => {
    expect(slugify("Acme")).not.toBe(slugify("Acme"));
  });
});


/** Builds a fake pg Pool whose client runs a scripted query sequence. */
function fakePool(onQuery: (sql: string) => unknown) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase());
      return onQuery(sql);
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool: pool as never, client, calls };
}

describe("Task 3 — transactional rollback (R1.2) and 409 mapping (R1.4)", () => {
  it("issues ROLLBACK and no COMMIT when a mid-transaction insert fails", async () => {
    const { pool, calls } = fakePool((sql) => {
      if (sql.includes("INSERT INTO organizations"))
        return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] };
      if (sql.includes("INSERT INTO users")) throw new Error("boom");
      return { rows: [] };
    });

    await expect(
      signup(pool, { organizationName: "X", email: "a@b.test", password: "password123" }),
    ).rejects.toThrow();

    expect(calls).toContain("BEGIN");
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("maps a unique-violation (23505) to a 409 AppError", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("INSERT INTO organizations"))
        return { rows: [{ id: "22222222-2222-2222-2222-222222222222" }] };
      if (sql.includes("INSERT INTO users")) {
        throw Object.assign(new Error("dup"), { code: "23505" });
      }
      return { rows: [] };
    });

    const err = await signup(pool, {
      organizationName: "X",
      email: "a@b.test",
      password: "password123",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe("CONFLICT");
  });
});
