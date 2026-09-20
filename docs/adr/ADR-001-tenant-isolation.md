# ADR-001 — Tenant isolation: shared DB, shared schema, PostgreSQL RLS

- **Status:** Accepted
- **Date:** 2026-08
- **Requirements:** R6, R7, NFR1.3

## Context

TenantForge is multi-tenant. We need provable isolation between tenants at startup-appropriate
cost, defensible in an interview. Three models were considered.

| Model | Pros | Cons |
|---|---|---|
| Shared DB, shared schema + RLS | Cheapest; scales to many tenants; one migration set | A single unscoped query *could* leak without RLS; noisy-neighbor |
| Shared DB, schema-per-tenant | Stronger isolation; per-tenant backup | Migrations run N times; schema sprawl |
| Database-per-tenant | Strongest isolation | Expensive; complex ops at scale |

## Decision

Shared schema with a `tenant_id` on every tenant-scoped table, **enforced with PostgreSQL
Row-Level Security** — `ENABLE` **and** `FORCE ROW LEVEL SECURITY` — and an application database
role that is **not** a superuser and does **not** hold `BYPASSRLS`. Tenant context is set
transaction-locally per request via `set_config('app.current_tenant_id', <id>, true)`.

## Consequences

- Isolation is enforced at the storage layer: a forgotten `WHERE`, a buggy query, or raw SQL on
  the app connection still cannot cross tenants.
- Every tenant-scoped table needs a policy; a CI `rls-lint` fails the build if one is missing.
- Migrations run as a separate owner/migrator role (RLS off on that connection).
- Cross-tenant admin/analytics is a separate authenticated path, not a tenant session.
- Proven by an automated cross-tenant isolation suite (API + ORM + raw SQL + write attempts →
  zero leakage).
