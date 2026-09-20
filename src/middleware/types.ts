import type { PoolClient } from "pg";
import type { AccessClaims } from "../auth/token.service";

/** Request augmentation: auth claims + the tenant-scoped DB connection for the request. */
declare module "fastify" {
  interface FastifyRequest {
    auth?: { userId: string; tenantId: string; role: AccessClaims["role"] };
    db?: PoolClient | undefined;
  }
}

export {};
