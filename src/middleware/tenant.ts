import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { errors } from "../errors";
import type { TokenService } from "../auth/token.service";
import { authenticateApiKey } from "../apikeys/apikey.service";
import "./types";

/**
 * authenticate (R3.5, R5.2): accepts EITHER a Bearer access token OR an `X-API-Key` header.
 * Sets req.auth. Rejects missing/expired/invalid credentials with 401 before any handler runs.
 *
 * API-key requests get role `member` (keys are for programmatic access, not privileged admin
 * actions); the same tenant context + RLS applies as JWT requests (R5.6), enforced by withTenant.
 */
export function makeAuthenticate(tokens: TokenService, ownerPool?: Pool) {
  return async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.length > 0) {
      if (!ownerPool) throw errors.unauthorized("API keys not enabled");
      const principal = await authenticateApiKey(ownerPool, apiKey);
      req.auth = { userId: principal.keyId, tenantId: principal.tenantId, role: "member" };
      return;
    }
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw errors.unauthorized("Missing bearer token");
    const token = header.slice("Bearer ".length);
    let claims;
    try {
      claims = await tokens.verifyAccessToken(token);
    } catch {
      throw errors.unauthorized("Invalid or expired token");
    }
    req.auth = { userId: claims.sub, tenantId: claims.tenant_id, role: claims.role };
  };
}

/**
 * withTenant (design §5, R6.4/R6.8/R6.9): binds the request to a transaction-local tenant
 * context on the app-role pool.
 *
 * - Acquires a connection, BEGIN, set_config('app.current_tenant_id', $1, true) — transaction-
 *   local (the `true`), never session-level, so context cannot bleed across pooled requests.
 * - Attaches req.db for handlers to use.
 * - On response finish: COMMIT (or ROLLBACK on error), RESET, release — guaranteed cleanup.
 * - Fails closed (403) if there is no authenticated tenant.
 */
export function makeWithTenant(appPool: Pool) {
  const open = async function withTenant(req: FastifyRequest): Promise<void> {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw errors.noTenant();
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      // Reject requests from a cancelled/soft-deleted tenant (R2.3).
      const org = await client.query<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM organizations WHERE id = $1",
        [tenantId],
      );
      if (org.rows[0]?.deleted_at != null) throw errors.forbidden("Organization is cancelled");
      req.db = client;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw e;
    }
  };

  /**
   * onSend hook: commit BEFORE the response is flushed so a durable write is guaranteed before
   * the client (or a fast follow-up request) observes success. Rolls back on 4xx/5xx.
   */
  const commit = async function commitTenant(
    req: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> {
    const client = req.db;
    if (!client) return payload;
    req.db = undefined;
    try {
      await client.query(reply.statusCode < 400 ? "COMMIT" : "ROLLBACK");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
    } finally {
      await client.query("RESET app.current_tenant_id").catch(() => {});
      client.release();
    }
    return payload;
  };

  /** onError hook: ensure rollback + release if the handler threw. */
  const onError = async function rollbackTenant(req: FastifyRequest): Promise<void> {
    const client = req.db;
    if (!client) return;
    req.db = undefined;
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.query("RESET app.current_tenant_id").catch(() => {});
      client.release();
    }
  };

  return { open, commit, onError };
}
