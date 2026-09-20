# ADR-003 — Rate limiting: atomic Redis token bucket (Lua)

- **Status:** Accepted
- **Date:** 2026-08
- **Requirements:** R12, R23

## Context

Per-tenant limits must hold across horizontally-scaled Fargate tasks. A per-instance in-memory
counter would let a client exceed the limit by a factor of the instance count. The check and the
decrement must be atomic to avoid a race between concurrent instances.

## Decision

Token bucket implemented as a **single Lua script** executed on Redis (`SCRIPT LOAD` → `EVALSHA`).
The script reads `{tokens, ts}`, refills based on elapsed time (capped at capacity), and
decrements — all atomically. Keyed by `tenant_id` for authenticated traffic (scaled by plan) and
by client IP + route class for pre-auth endpoints (stricter on credential routes). Standard
`X-RateLimit-*` headers on allow; `429` + `Retry-After` when empty.

**Fail policy:** if Redis is unavailable, fail-**closed** (`503`) on mutating/auth-adjacent routes
and fail-**open** on idempotent reads, emitting a degraded-state metric. The Stripe webhook is
exempt from limiting (protected by signature verification instead).

## Consequences

- Redis (ElastiCache) is on the hot path; the fail policy bounds the blast radius of an outage.
- Allows short bursts while enforcing a sustained average — closer to how real API limits behave.
- Verified: two limiter instances sharing one Redis never exceed the bucket capacity in aggregate.
