/**
 * Consistent error contract (R14.4, R14.5). Every error returned to a client uses the envelope:
 *   { "error": { "code", "message", "request_id" } }
 * No stack traces, SQL, or driver errors ever leak to clients.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NO_TENANT_CONTEXT"
  | "RESOURCE_NOT_FOUND"
  | "CONFLICT"
  | "GONE"
  | "PAYMENT_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "BAD_GATEWAY"
  | "INTERNAL";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errors = {
  badRequest: (m = "Bad request") => new AppError(400, "VALIDATION_FAILED", m),
  unauthorized: (m = "Unauthorized") => new AppError(401, "UNAUTHORIZED", m),
  forbidden: (m = "Forbidden") => new AppError(403, "FORBIDDEN", m),
  noTenant: (m = "No tenant context") => new AppError(403, "NO_TENANT_CONTEXT", m),
  notFound: (m = "Resource not found") => new AppError(404, "RESOURCE_NOT_FOUND", m),
  conflict: (m = "Conflict") => new AppError(409, "CONFLICT", m),
  gone: (m = "Gone") => new AppError(410, "GONE", m),
  paymentRequired: (m = "Payment required") => new AppError(402, "PAYMENT_REQUIRED", m),
  quotaExceeded: (m = "Quota exceeded") => new AppError(403, "QUOTA_EXCEEDED", m),
  badGateway: (m = "Upstream service error") => new AppError(502, "BAD_GATEWAY", m),
};

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; request_id: string };
}

export function toEnvelope(code: ErrorCode, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, request_id: requestId } };
}
