# ADR-002 — Auth: custom JWT + rotating refresh tokens with reuse detection

- **Status:** Accepted
- **Date:** 2026-08
- **Requirements:** R3, R4

## Context

We need secure session management with a small blast radius on token theft, and we want to
demonstrate the mechanics (a managed IdP would hide them). Options: fully managed (Cognito),
long-lived JWTs, or custom short-lived access + rotating refresh.

## Decision

- Short-lived **access JWT** (≤ 15 min) carrying `sub`, `tenant_id`, `role`, signed HS256 with a
  key from Secrets Manager.
- Long-lived **refresh token**, random, **hashed at rest**, grouped by a `family_id`.
- **Rotation on every exchange**: the presented token is marked used and a new token issued in
  the same family.
- **Reuse detection**: presenting a used/revoked token (outside a short rotation-overlap window)
  revokes the **entire family** — the stolen-token defense.
- Org-scoped **RBAC**: `owner > admin > member`, derived only from the verified token claim.

Cognito is documented as the drop-in "at scale" alternative.

## Consequences

- We own token storage, rotation, and revocation, and must test the reuse-detection path
  (covered by an integration test: reuse revokes the family, both old and rotated tokens fail).
- The refresh-token record carries `tenant_id`; lookup is by unique hash so it can't enumerate
  other tenants (bootstrapping note in design §5.2).
