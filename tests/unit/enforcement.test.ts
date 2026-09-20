import { describe, expect, it, vi } from "vitest";
import {
  assertProjectQuota,
  assertWriteAllowed,
  PROJECT_QUOTA,
} from "../../src/billing/enforcement.service";
import { AppError } from "../../src/errors";

describe("Task 15b — degraded-access matrix (R11.1)", () => {
  it("allows writes for active/trialing", () => {
    expect(() => assertWriteAllowed("active")).not.toThrow();
    expect(() => assertWriteAllowed("trialing")).not.toThrow();
  });

  it("blocks writes with 402 for past_due and canceled", () => {
    for (const status of ["past_due", "canceled"] as const) {
      const err = (() => {
        try {
          assertWriteAllowed(status);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(402);
      expect((err as AppError).code).toBe("PAYMENT_REQUIRED");
    }
  });
});

describe("Task 15b — project quotas (R21)", () => {
  const fakeDb = (count: number) =>
    ({ query: vi.fn(async () => ({ rows: [{ n: count }] })) }) as never;

  it("allows creation under the free cap (3)", async () => {
    await expect(assertProjectQuota(fakeDb(2), "free")).resolves.toBeUndefined();
  });

  it("rejects creation at/over the free cap with 403 QUOTA_EXCEEDED", async () => {
    const err = await assertProjectQuota(fakeDb(3), "free").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
    expect((err as AppError).code).toBe("QUOTA_EXCEEDED");
  });

  it("allows unlimited for pro regardless of count", async () => {
    expect(PROJECT_QUOTA.pro).toBeNull();
    await expect(assertProjectQuota(fakeDb(9999), "pro")).resolves.toBeUndefined();
  });

  it("enforces the starter cap (25)", async () => {
    await expect(assertProjectQuota(fakeDb(24), "starter")).resolves.toBeUndefined();
    await expect(assertProjectQuota(fakeDb(25), "starter")).rejects.toBeInstanceOf(AppError);
  });
});
