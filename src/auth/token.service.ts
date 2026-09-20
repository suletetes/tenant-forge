import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/** Access-token claims (R3.1): subject, tenant, and role. */
export interface AccessClaims extends JWTPayload {
  sub: string;
  tenant_id: string;
  role: "owner" | "admin" | "member";
}

export interface TokenServiceConfig {
  signingSecret: string;
  accessTtlSeconds: number; // capped at 900 by config (R3.1)
  refreshTtlSeconds: number;
}

const ISSUER = "tenantforge";
const AUDIENCE = "tenantforge-api";

export class TokenService {
  private readonly key: Uint8Array;

  constructor(private readonly cfg: TokenServiceConfig) {
    this.key = new TextEncoder().encode(cfg.signingSecret);
  }

  /** Signs a short-lived access JWT (R3.1). */
  async signAccessToken(claims: {
    sub: string;
    tenantId: string;
    role: AccessClaims["role"];
  }): Promise<string> {
    return new SignJWT({ tenant_id: claims.tenantId, role: claims.role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.cfg.accessTtlSeconds}s`)
      .sign(this.key);
  }

  /** Verifies an access JWT; throws on expiry/invalid signature (R3.5). */
  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload as AccessClaims;
  }

  /**
   * Generates an opaque refresh token (returned to the client once) and its storage hash
   * (persisted). Only the hash is ever stored (R3.2).
   */
  generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: hashRefreshToken(token) };
  }

  refreshExpiry(now = new Date()): Date {
    return new Date(now.getTime() + this.cfg.refreshTtlSeconds * 1000);
  }
}

/** SHA-256 hash for refresh-token storage/lookup. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
