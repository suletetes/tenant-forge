import { describe, expect, it } from "vitest";
import { TokenService, hashRefreshToken } from "../../src/auth/token.service";

const svc = new TokenService({
  signingSecret: "unit-test-secret-that-is-at-least-32-bytes!!",
  accessTtlSeconds: 900,
  refreshTtlSeconds: 1_209_600,
});

describe("Task 4 — access token claims & verification (R3.1, R3.5)", () => {
  it("signs an access token carrying sub, tenant_id, role", async () => {
    const t = await svc.signAccessToken({ sub: "u1", tenantId: "t1", role: "owner" });
    const claims = await svc.verifyAccessToken(t);
    expect(claims.sub).toBe("u1");
    expect(claims.tenant_id).toBe("t1");
    expect(claims.role).toBe("owner");
  });

  it("sets an expiry within 15 minutes (R3.1)", async () => {
    const t = await svc.signAccessToken({ sub: "u1", tenantId: "t1", role: "member" });
    const claims = await svc.verifyAccessToken(t);
    const ttl = (claims.exp ?? 0) - (claims.iat ?? 0);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it("rejects a token signed with a different secret (R3.5)", async () => {
    const other = new TokenService({
      signingSecret: "a-different-secret-of-at-least-32-bytes!!!",
      accessTtlSeconds: 900,
      refreshTtlSeconds: 1_209_600,
    });
    const forged = await other.signAccessToken({ sub: "u1", tenantId: "t1", role: "member" });
    await expect(svc.verifyAccessToken(forged)).rejects.toThrow();
  });
});

describe("Task 4 — refresh token hashing (R3.2)", () => {
  it("returns an opaque token and a deterministic storage hash (never equal)", () => {
    const { token, hash } = svc.generateRefreshToken();
    expect(token).toBeTruthy();
    expect(hash).not.toBe(token);
    expect(hash).toBe(hashRefreshToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("computes a refresh expiry in the future", () => {
    expect(svc.refreshExpiry().getTime()).toBeGreaterThan(Date.now());
  });
});
