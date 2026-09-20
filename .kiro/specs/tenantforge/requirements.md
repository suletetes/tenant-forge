# TenantForge — Requirements

> **Spec:** `tenantforge`
> **Status:** Draft (v1)
> **Source of truth:** [`PROJECT-Multi-Tenant-SaaS-Backend.md`](../../../PROJECT-Multi-Tenant-SaaS-Backend.md)
> **Related:** [`design.md`](./design.md) · [`tasks.md`](./tasks.md)

## Introduction

TenantForge is a production-ready multi-tenant SaaS API platform. Multiple organizations
(tenants) sign up, subscribe to a plan via Stripe, and consume a versioned REST API. The
platform's defining engineering property is **provable tenant isolation** enforced at the
database layer with PostgreSQL Row-Level Security (RLS) — not merely application-level
`WHERE tenant_id = ?` filtering — plus signed and idempotent Stripe billing, per-tenant Redis
token-bucket rate limiting, JWT authentication with refresh-token rotation, a deliberate API
versioning strategy, and full AWS + Terraform + CI/CD deployment automation. It also covers the
supporting capabilities a real SaaS needs: team management (invitations + role assignment),
credential recovery (password reset + email verification), plan quotas distinct from rate limits,
pre-authentication / IP-based limiting, and tenant data export.

> **Requirement numbering note:** R1–R19 are the original core set; R20–R24 were added in the
> v1.1 revision (team management, quotas, password reset, pre-auth limiting, data export) and are
> grouped into their owning capabilities rather than appended, so existing `R#` references remain
> stable. IDs are non-contiguous by capability by design.

### Requirement notation (EARS)

Acceptance criteria use the **Easy Approach to Requirements Syntax (EARS)**:

- **Ubiquitous:** `THE SYSTEM SHALL <response>`
- **Event-driven:** `WHEN <trigger> THE SYSTEM SHALL <response>`
- **State-driven:** `WHILE <state> THE SYSTEM SHALL <response>`
- **Conditional:** `IF <condition> THEN THE SYSTEM SHALL <response>`
- **Optional feature:** `WHERE <feature is present> THE SYSTEM SHALL <response>`

Each requirement is tagged (e.g. `R3.2`) so tasks and design sections can trace back to it.

### Glossary

| Term | Meaning |
|---|---|
| **Tenant / Organization** | A customer account. Every tenant-scoped row carries a `tenant_id`. |
| **RLS** | PostgreSQL Row-Level Security — database-enforced row filtering. |
| **App role** | The non-superuser Postgres role the API connects as; has **no** `BYPASSRLS`. |
| **Migration role** | A separate Postgres role used only by migrations; owns tables / may bypass RLS. |
| **Plan** | Subscription tier: `free`, `starter`, `pro`. Drives rate limit, quota, and feature gating (limits in R12.1 / R21). |
| **Rate limit** | Requests-per-window ceiling (token bucket). Distinct from **quota**. |
| **Quota** | A count/consumption cap over a plan (e.g. max `projects`, monthly request cap). Distinct from rate limit (R21). |
| **Token family** | A chain of refresh tokens descended from one login; reuse revokes the whole family. |
| **Degraded access** | The restricted capability set granted to a `past_due` / `canceled` tenant (matrix in R11.1). |

---

## Capability 1 — Tenant Signup & Provisioning

### Requirement R1 — Self-service tenant signup

**User story:** As a new customer, I want to sign up and get an organization with an owner
account, so that I can start using the API immediately.

#### Acceptance criteria

1. WHEN a signup request is received with a valid organization name, owner email, and password THE SYSTEM SHALL create an `organizations` row, a `users` row with role `owner`, and default plan `free` **within a single database transaction**.
2. IF any step of provisioning fails THEN THE SYSTEM SHALL roll back the entire transaction so no orphan `organizations` or `users` rows remain.
3. WHEN provisioning succeeds THE SYSTEM SHALL generate a unique `slug` for the organization suitable for subdomain/path routing.
4. IF the owner email is already registered within the same organization THEN THE SYSTEM SHALL reject the signup with `409 Conflict` and SHALL NOT reveal whether the email exists in a different tenant.
5. WHEN an organization is created THE SYSTEM SHALL write an `audit_log` entry (`action = "org.created"`) scoped to the new `tenant_id`.
6. THE SYSTEM SHALL store passwords only as Argon2id (or bcrypt) hashes and SHALL NEVER store or log plaintext passwords.

### Requirement R2 — Tenant lifecycle (soft delete & retention)

**User story:** As a platform operator, I want tenant cancellation to be safe and reversible for a
grace period, so that we never lose data through an accidental hard delete or a cascade timeout.

#### Acceptance criteria

1. WHEN a tenant is cancelled THE SYSTEM SHALL soft-delete it by setting `organizations.deleted_at` rather than issuing a `DELETE`.
2. WHEN a tenant is soft-deleted THE SYSTEM SHALL revoke all active refresh-token families for that tenant.
3. WHILE a tenant has a non-null `deleted_at` THE SYSTEM SHALL reject all authenticated API requests for that tenant with `403 Forbidden`.
4. WHERE a background purge job is present THE SYSTEM SHALL delete tenant-scoped data in bounded batches to avoid long-running cascade locks.

---

## Capability 2 — Authentication, Refresh Rotation & RBAC

### Requirement R3 — JWT authentication with refresh-token rotation

**User story:** As an API consumer, I want secure login that keeps me signed in without
long-lived bearer tokens, so that a leaked token has a small blast radius.

#### Acceptance criteria

1. WHEN valid credentials are presented THE SYSTEM SHALL issue a short-lived access JWT (≤ 15 minutes) carrying `sub`, `tenant_id`, and `role` claims, plus a long-lived refresh token.
2. THE SYSTEM SHALL store refresh tokens only as hashes at rest and SHALL associate each with a `family_id`.
3. WHEN a refresh token is exchanged THE SYSTEM SHALL issue a new access token AND a new refresh token, mark the presented refresh token as `used`, and keep the new token in the same `family_id`.
4. IF a refresh token that has already been used or revoked is presented THEN THE SYSTEM SHALL revoke the **entire token family** and reject the request with `401 Unauthorized`.
5. WHEN an access token is expired or its signature is invalid THE SYSTEM SHALL reject the request with `401 Unauthorized` and SHALL NOT process the route handler.
6. WHERE a rotation-overlap window is configured THE SYSTEM SHALL accept the immediately-previous refresh token within that window to tolerate client retry races without triggering false reuse detection.
7. THE SYSTEM SHALL NEVER log access tokens, refresh tokens, password hashes, or signing keys.

### Requirement R4 — Organization-scoped RBAC

**User story:** As an organization owner, I want roles within my org, so that members have only
the permissions they need.

#### Acceptance criteria

1. THE SYSTEM SHALL support the roles `owner`, `admin`, and `member` with the precedence `owner > admin > member`.
2. WHEN a request targets a route requiring a minimum role THE SYSTEM SHALL authorize it only if the caller's role meets or exceeds that minimum.
3. IF a caller's role is insufficient THEN THE SYSTEM SHALL reject the request with `403 Forbidden`.
4. THE SYSTEM SHALL derive the caller's role from the verified access-token claim, never from a client-supplied header or body field.

### Requirement R5 — API keys for programmatic access

**User story:** As a developer integrating TenantForge, I want tenant-scoped API keys, so that my
server-to-server jobs can authenticate without a user login.

#### Acceptance criteria

1. WHEN an authorized user creates an API key THE SYSTEM SHALL return the plaintext key exactly once and SHALL persist only its hash in `api_keys.hashed_key`.
2. WHEN a request presents a valid, non-revoked API key THE SYSTEM SHALL resolve its `tenant_id` and process the request under that tenant's scope.
3. IF a presented API key is revoked (`revoked_at` set) THEN THE SYSTEM SHALL reject the request with `401 Unauthorized`.
4. WHEN an API key is used THE SYSTEM SHALL update `last_used_at` without blocking the request path.
5. THE SYSTEM SHALL allow only users with role `admin` or `owner` to create or revoke API keys, authorized per R4.
6. WHEN a request is authenticated by an API key THE SYSTEM SHALL set the same transaction-local tenant context as a JWT request (R6.4), so key-based traffic is subject to identical RLS isolation.

### Requirement R20 — User invitation & role assignment

**User story:** As an organization owner or admin, I want to invite teammates and assign their
roles, so that my organization is more than a single user and RBAC is meaningful.

#### Acceptance criteria

1. WHEN a user with role `owner` or `admin` invites an email to their organization THE SYSTEM SHALL create a pending invitation scoped to that `tenant_id` with a target role of `admin` or `member` and a single-use, time-limited invitation token.
2. IF a `member` attempts to create an invitation THEN THE SYSTEM SHALL reject it with `403 Forbidden`.
3. WHEN a valid, unexpired invitation token is accepted with a password THE SYSTEM SHALL create a `users` row in the inviting tenant with the invited role and mark the invitation consumed.
4. IF an invitation token is expired, already consumed, or unknown THEN THE SYSTEM SHALL reject acceptance with `410 Gone` (or `400`) and SHALL NOT create a user.
5. WHEN a user with role `owner` or `admin` changes another user's role THE SYSTEM SHALL update it, subject to R20.6, and write an `audit_log` entry.
6. THE SYSTEM SHALL ensure every organization retains at least one `owner`; IF an action would remove the last `owner` THEN THE SYSTEM SHALL reject it with `409 Conflict`.
7. WHEN an invitation is created or a role is changed THE SYSTEM SHALL scope all reads/writes to the acting tenant under RLS (R6).

### Requirement R22 — Password reset & email verification

**User story:** As a user, I want to recover access if I forget my password and confirm ownership
of my email, so that account access is secure and self-serviceable.

#### Acceptance criteria

1. WHEN a password-reset is requested for an email THE SYSTEM SHALL always respond with the same success shape regardless of whether the email exists, to avoid account enumeration.
2. IF the email maps to a user THEN THE SYSTEM SHALL generate a single-use, time-limited reset token delivered out-of-band (email) and SHALL store only its hash.
3. WHEN a valid, unexpired reset token is presented with a new password THE SYSTEM SHALL update the password hash (Argon2id), consume the token, and revoke all of that user's refresh-token families (R3.4).
4. IF a reset token is expired, consumed, or unknown THEN THE SYSTEM SHALL reject the reset with `400 Bad Request` and SHALL NOT change the password.
5. WHEN an authenticated user changes their own password THE SYSTEM SHALL require the current password and SHALL revoke all other refresh-token families for that user.
6. WHERE email verification is enabled THE SYSTEM SHALL mark a user `email_verified` only after a single-use verification token is confirmed, and MAY restrict sensitive actions until verified.
7. THE SYSTEM SHALL NEVER log reset or verification tokens (reinforces R3.7).

---

## Capability 3 — Tenant Isolation (Row-Level Security)

### Requirement R6 — Database-enforced tenant isolation

**User story:** As a security-conscious buyer, I want my organization's data to be physically
invisible to other tenants, so that a single application bug cannot leak it.

#### Acceptance criteria

1. THE SYSTEM SHALL define a `tenant_id` column that is `NOT NULL` on every tenant-scoped table.
2. THE SYSTEM SHALL `ENABLE` **and** `FORCE ROW LEVEL SECURITY` on every tenant-scoped table.
3. THE SYSTEM SHALL connect application traffic using a Postgres role that is not a superuser and does not hold `BYPASSRLS`.
4. WHEN a request is authenticated THE SYSTEM SHALL set the tenant context with `set_config('app.current_tenant_id', <tenant_id>, true)` inside the request transaction (transaction-local), never with session-level `SET`.
5. WHILE a request transaction is active THE SYSTEM SHALL ensure every query against a tenant-scoped table is filtered by the RLS policy `tenant_id = current_setting('app.current_tenant_id')::uuid`.
6. **(Signature criterion)** WHEN an automated test authenticated as Tenant A attempts to read rows belonging to Tenant B — via the API, via the ORM, and via **raw SQL** on the app connection — THE SYSTEM SHALL return zero rows for every such attempt.
7. **(Signature criterion)** WHEN an automated test authenticated as Tenant A attempts to insert or update a row with Tenant B's `tenant_id` THE SYSTEM SHALL reject the write via the RLS `WITH CHECK` clause.
8. IF a request reaches a tenant-scoped query without a tenant context set THEN THE SYSTEM SHALL fail closed (return zero rows / error) rather than returning cross-tenant data.
9. WHEN a pooled connection is returned to the pool THE SYSTEM SHALL guarantee the tenant context does not persist to the next request (via transaction-local scope and an explicit reset in the cleanup path).

### Requirement R7 — Cross-tenant admin access is isolated

**User story:** As a platform operator, I want cross-tenant admin endpoints separated from tenant
traffic, so that a tenant user can never reach aggregate data.

#### Acceptance criteria

1. WHERE cross-tenant admin routes exist THE SYSTEM SHALL authenticate them through a separate mechanism (dedicated admin role/issuer or a distinct bypass DB role), never a tenant user session.
2. IF a tenant user's access token is presented to an admin aggregation route THEN THE SYSTEM SHALL reject it with `403 Forbidden`.
3. WHEN an admin route bypasses RLS THE SYSTEM SHALL do so explicitly and SHALL record the access in the audit log.

---

## Capability 4 — Resource CRUD (`projects`)

### Requirement R8 — Tenant-scoped resource management

**User story:** As an organization member, I want to create and manage `projects`, so that I have
real product data behind the API. (`projects` is the demonstration resource; the pattern
generalizes to any tenant-scoped resource.)

#### Acceptance criteria

1. THE SYSTEM SHALL expose create, read (single + list), update, and delete operations for `projects` under a versioned route prefix (`/v1/projects`).
2. WHEN a `projects` row is created THE SYSTEM SHALL stamp it with the caller's `tenant_id` derived from the token, never from the request body.
3. THE SYSTEM SHALL use UUID primary keys for `projects` so resources cannot be enumerated by incrementing integers.
4. WHEN listing `projects` THE SYSTEM SHALL return only the caller's tenant's rows and SHALL support cursor-based pagination (see R14).
5. WHEN a mutating `projects` operation succeeds THE SYSTEM SHALL write an `audit_log` entry recording actor, action, and target.
6. IF a request references a `projects` id that does not exist within the caller's tenant THEN THE SYSTEM SHALL return `404 Not Found` (indistinguishable from a row owned by another tenant).

---

## Capability 5 — Subscription Billing (Stripe)

### Requirement R9 — Subscription lifecycle via Stripe

**User story:** As a customer, I want to subscribe to and manage a paid plan, so that I can unlock
higher quotas and features.

#### Acceptance criteria

1. WHEN a tenant initiates a subscription THE SYSTEM SHALL create (or reuse) a Stripe customer, persist `organizations.stripe_customer_id`, and start a Checkout/subscription flow.
2. THE SYSTEM SHALL allow a subscribed tenant to open the Stripe Customer Portal to change or cancel their plan.
3. WHEN a subscription becomes active THE SYSTEM SHALL set `organizations.plan` and `subscriptions.status = "active"` and grant that plan's quota and features.
4. THE SYSTEM SHALL operate against Stripe **test mode** for all non-production environments so no real money moves.

### Requirement R10 — Signed, idempotent webhook handling

**User story:** As an operator, I want billing webhooks to be tamper-proof and safe under
redelivery, so that duplicated or forged events cannot corrupt subscription state.

#### Acceptance criteria

1. WHEN a webhook is received THE SYSTEM SHALL verify the `Stripe-Signature` header using the endpoint signing secret and a narrow timestamp tolerance before any processing.
2. IF signature verification fails THEN THE SYSTEM SHALL reject the request with `400 Bad Request` and SHALL NOT mutate any state.
3. WHEN a verified webhook is processed THE SYSTEM SHALL insert the Stripe `event.id` into `processed_webhooks` (UNIQUE) **before** performing business logic; IF the insert violates the unique constraint THEN THE SYSTEM SHALL treat the event as already processed and return `200 OK` without reprocessing.
4. WHEN syncing subscription state THE SYSTEM SHALL refetch the current object from the Stripe API rather than trusting the event payload, so out-of-order delivery cannot regress state.
5. WHEN handling `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, and `invoice.payment_failed` THE SYSTEM SHALL update `subscriptions.status` and `organizations.plan` accordingly.
6. WHEN an `invoice.payment_failed` event is processed THE SYSTEM SHALL set the tenant to `past_due` and record the failure; the dunning policy is: retain read-only + billing access per the R11.1 matrix, and rely on Stripe Smart Retries for reattempts. IF the subscription reaches Stripe status `canceled` THEN THE SYSTEM SHALL downgrade the tenant to `free` entitlements.
7. THE SYSTEM SHALL complete webhook processing synchronously within a 5-second budget and return `2xx`; IF processing would exceed the budget THEN THE SYSTEM SHALL enqueue the work (recording the event in `processed_webhooks` first per R10.3) and return `200` immediately so Stripe does not retry unnecessarily.

### Requirement R11 — Plan enforcement on the request path

**User story:** As the business, I want unpaid tenants restricted, so that plan status is enforced,
not just recorded.

#### Acceptance criteria

1. WHILE a tenant's subscription status is `past_due` or `canceled` THE SYSTEM SHALL apply the following **degraded-access matrix**:

   | Capability | `active`/`trialing` | `past_due` | `canceled` |
   |---|---|---|---|
   | Read tenant resources (GET `/projects`) | ✅ | ✅ (read-only) | ✅ (read-only) |
   | Create/update/delete resources | ✅ | ❌ `402 Payment Required` | ❌ `402` |
   | Billing endpoints (Checkout, Customer Portal) | ✅ | ✅ | ✅ |
   | Auth (login, refresh, logout) | ✅ | ✅ | ✅ |
   | Rate-limit ceiling | plan tier | `free` tier | `free` tier |

   IF a restricted (write) call is attempted THEN THE SYSTEM SHALL reject it with `402 Payment Required` and a machine-readable `code` indicating the billing state.
2. WHEN a tenant's plan changes THE SYSTEM SHALL apply the new quota and feature set to subsequent requests without a redeploy.
3. THE SYSTEM SHALL derive plan/feature entitlements from persisted subscription state, never from a client-supplied value.

---

## Capability 6 — Rate Limiting & Quotas

> Covers per-tenant token-bucket limiting (R12), plan resource quotas (R21), and
> pre-authentication / IP-based limiting for unauthenticated endpoints (R23).

### Requirement R12 — Per-tenant token-bucket rate limiting

**User story:** As the platform, I want per-tenant rate limits that hold across all API instances,
so that one noisy tenant cannot degrade others.

#### Acceptance criteria

1. THE SYSTEM SHALL enforce rate limits per tenant (keyed by `tenant_id`), scaled by plan: `free` = 60 req/min (bucket 60, refill 1/s), `starter` = 300 req/min (bucket 300, refill 5/s), `pro` = 1000 req/min (bucket 1000, refill ~16.7/s).
2. THE SYSTEM SHALL implement the token-bucket check-refill-decrement as a **single atomic Redis Lua script** so the limit holds correctly across horizontally scaled Fargate tasks.
3. WHEN a request is allowed THE SYSTEM SHALL return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.
4. IF a tenant's bucket is empty THEN THE SYSTEM SHALL reject the request with `429 Too Many Requests` and a `Retry-After` header.
5. WHEN two API instances evaluate the limiter concurrently for the same tenant THE SYSTEM SHALL NOT allow the combined allowed count to exceed the bucket capacity (no per-instance over-count).
6. IF the Redis limiter is unavailable THEN THE SYSTEM SHALL apply this policy: **fail-closed** (reject with `503`) on mutating and auth-adjacent routes, and **fail-open** (allow, unlimited) on idempotent read (`GET`) routes; and in both cases SHALL emit a `ratelimiter_degraded` metric.

### Requirement R21 — Plan quotas (distinct from rate limits)

**User story:** As the business, I want hard resource caps per plan, so that plan tiers differ by
more than request rate.

#### Acceptance criteria

1. THE SYSTEM SHALL enforce a maximum active `projects` count per plan: `free` = 3, `starter` = 25, `pro` = unlimited.
2. IF a create operation would exceed the plan's resource quota THEN THE SYSTEM SHALL reject it with `403 Forbidden` and a `code` of `QUOTA_EXCEEDED`.
3. THE SYSTEM SHALL derive quota ceilings from persisted plan state, never from client input (reinforces R11.3).
4. WHERE a monthly request quota is configured THE SYSTEM SHALL count requests per tenant per calendar month and reject over-quota calls with `429`, independent of the per-minute rate limit (R12).

### Requirement R23 — Pre-authentication / IP-based rate limiting

**User story:** As a security owner, I want unauthenticated endpoints protected from abuse, so that
signup, login, password-reset, and webhook endpoints cannot be brute-forced or flooded.

#### Acceptance criteria

1. THE SYSTEM SHALL rate-limit unauthenticated routes (signup, login, password-reset request, invitation acceptance) keyed by client IP, since no `tenant_id` exists yet.
2. WHEN the IP-based limit is exceeded THE SYSTEM SHALL reject with `429 Too Many Requests` and a `Retry-After` header.
3. THE SYSTEM SHALL apply a stricter limit to credential endpoints (login, password-reset) than to general unauthenticated traffic to blunt brute-force attempts.
4. THE SYSTEM SHALL **exempt the Stripe `/webhook` endpoint from per-tenant and IP rate limiting** (it has no tenant context and is protected by signature verification per R10.1); WHERE additional webhook flood protection is present THE SYSTEM SHALL apply it at the edge (WAF) rather than the per-tenant limiter.
5. THE SYSTEM SHALL derive the client IP from the trusted proxy header set by the ALB/CloudFront edge, not from an arbitrary client-supplied header.

---

## Capability 7 — API Versioning & Contracts

### Requirement R13 — Versioning strategy

**User story:** As an existing customer, I want the API to evolve without breaking my integration,
so that upgrades are opt-in.

#### Acceptance criteria

1. THE SYSTEM SHALL expose all endpoints under a version prefix (`/v1/...`).
2. WHEN a breaking change is required THE SYSTEM SHALL introduce it under a new prefix (`/v2/...`) while keeping `/v1` behavior frozen.
3. WHILE both versions are published THE SYSTEM SHALL serve `/v1` and `/v2` concurrently with independent contracts.

### Requirement R14 — Pagination, error contract & OpenAPI

**User story:** As an API consumer, I want predictable responses and machine-readable docs, so
that I can build a reliable client.

#### Acceptance criteria

1. THE SYSTEM SHALL validate every request and serialize every response against a Zod schema that is the single source of truth.
2. THE SYSTEM SHALL auto-generate an OpenAPI 3.1 document from those schemas, commit it to the repo, and serve interactive docs (Swagger UI).
3. WHEN a list endpoint is called THE SYSTEM SHALL support cursor-based pagination returning a stable `next_cursor` and SHALL cap page size.
4. WHEN any error occurs THE SYSTEM SHALL return a consistent error envelope containing a stable machine-readable `code`, a human-readable `message`, and a `request_id`.
5. THE SYSTEM SHALL NOT leak internal implementation details (stack traces, SQL, driver errors) in error responses.

---

## Capability 8 — Observability & Audit

### Requirement R15 — Structured logging, tracing & correlation

**User story:** As an on-call engineer, I want traceable logs and metrics, so that I can diagnose
issues quickly and per tenant.

#### Acceptance criteria

1. THE SYSTEM SHALL emit structured JSON logs from the first commit, including a per-request correlation id and (when authenticated) `tenant_id`.
2. THE SYSTEM SHALL propagate the correlation id across the middleware chain and downstream calls, and return it to the client as `request_id`.
3. WHERE tracing is enabled THE SYSTEM SHALL record spans (X-Ray) across auth → rate limit → plan check → handler → database.
4. THE SYSTEM SHALL publish metrics for error rate, p99 latency, and `429` rate.
5. THE SYSTEM SHALL NEVER include secrets, tokens, or PII beyond what is necessary in logs.

### Requirement R16 — Audit trail

**User story:** As a compliance reviewer, I want a per-tenant record of who did what, so that
sensitive actions are accountable.

#### Acceptance criteria

1. WHEN a security- or billing-significant action occurs (signup, login, key creation/revocation, plan change, resource mutation, admin access) THE SYSTEM SHALL write an `audit_log` row with `tenant_id`, `actor_user_id`, `action`, `target`, and `metadata`.
2. THE SYSTEM SHALL scope `audit_log` reads to the owning tenant under the same RLS policy as other tenant-scoped tables.
3. WHERE CloudTrail is enabled THE SYSTEM SHALL retain infrastructure-level audit events independently of the application audit log.

### Requirement R24 — Tenant data export (compliance)

**User story:** As a tenant admin (or compliance reviewer), I want to export all of my
organization's data, so that we can satisfy portability/GDPR requests.

#### Acceptance criteria

1. WHEN a user with role `owner` or `admin` requests a data export THE SYSTEM SHALL produce a machine-readable archive of every tenant-scoped table for that `tenant_id`.
2. THE SYSTEM SHALL build the export from the tenant-scoped-table registry (see design §3.2) so tables added later are not silently omitted.
3. WHILE building an export THE SYSTEM SHALL enforce the same RLS tenant scoping as normal traffic, so no other tenant's rows are included.
4. THE SYSTEM SHALL exclude secret material (password hashes, hashed tokens, hashed API keys) from exports.

---

## Capability 9 — DevOps, Deployment & Environments

### Requirement R17 — Infrastructure as Code

**User story:** As a platform engineer, I want all infrastructure defined in Terraform, so that
environments are reproducible and reviewable.

#### Acceptance criteria

1. THE SYSTEM SHALL define VPC, RDS (PostgreSQL), ECS Fargate, ElastiCache (Redis), ALB, WAF, IAM, and Secrets Manager as Terraform modules.
2. THE SYSTEM SHALL store Terraform state remotely in S3 with a DynamoDB state lock.
3. THE SYSTEM SHALL grant IAM permissions on a least-privilege basis per component.
4. THE SYSTEM SHALL store all secrets (DB credentials, Stripe keys, JWT signing key) in AWS Secrets Manager and SHALL NEVER commit them to the repo or bake them into images.

### Requirement R18 — CI/CD with migrations and environment promotion

**User story:** As a developer, I want a safe automated pipeline, so that shipping is fast and
schema changes are applied predictably.

#### Acceptance criteria

1. WHEN code is pushed THE SYSTEM SHALL run lint → tests → build image → push to ECR in CI.
2. WHEN deploying THE SYSTEM SHALL run database migrations as an explicit pipeline step **with a defined rollback path**, using the migration role (not the app role).
3. WHEN migrations succeed THE SYSTEM SHALL deploy the new task to ECS and run a smoke test before marking the deploy healthy.
4. THE SYSTEM SHALL promote changes through `staging` before `prod`, with `staging` gating `prod`.
5. IF a smoke test fails after deploy THEN THE SYSTEM SHALL surface the failure and support rollback to the last healthy task/migration state.

### Requirement R19 — Edge security & alarms

**User story:** As a security owner, I want the platform hardened at the edge and monitored, so
that common attacks are blocked and incidents page us.

#### Acceptance criteria

1. THE SYSTEM SHALL attach a WAF with OWASP managed rules to the ALB/CloudFront edge.
2. THE SYSTEM SHALL configure CloudWatch alarms for error rate, p99 latency, and `429` spikes, wired to an SNS notification target.
3. THE SYSTEM SHALL terminate TLS at the edge and reject plaintext HTTP.

---

## Non-Functional Requirements

### NFR1 — Security

1. THE SYSTEM SHALL apply secure HTTP headers (HSTS, X-Content-Type-Options, appropriate CORS) and parameterized queries throughout.
2. THE SYSTEM SHALL enforce input validation on all external input via Zod before it reaches business logic.
3. THE SYSTEM SHALL keep the app DB role free of `BYPASSRLS` and superuser rights (reinforces R6).

### NFR2 — Performance & scalability

1. THE SYSTEM SHALL sustain a baseline of ≥ 200 req/s across tenants with **p99 latency < 250 ms for read (GET) endpoints and < 400 ms for writes** at that load, WHILE per-tenant rate limits continue to hold. (Provisional targets; the k6 report in Task 20 records the measured baseline and may refine these with justification.)
2. THE SYSTEM SHALL index `tenant_id` as the leftmost column of every composite index on tenant-scoped tables.
3. THE SYSTEM SHALL run statelessly on ECS Fargate so it scales horizontally without per-instance rate-limit or session state.

### NFR3 — Cost & teardown

1. THE SYSTEM SHALL run at approximately **$10–$15/month** while active by using the smallest viable RDS (`db.t4g.micro`) and ElastiCache node.
2. THE SYSTEM SHALL avoid a managed NAT Gateway (≈ $32/mo alone) in the default topology, instead using VPC Gateway/Interface Endpoints (S3, ECR, Secrets Manager, CloudWatch Logs) for private-subnet egress, so the cost target is achievable; IF a NAT Gateway is used THEN the cost target SHALL be documented with that caveat.
3. THE SYSTEM SHALL support full teardown via `terraform destroy` between demo sessions, retaining only the repo, diagrams, committed OpenAPI spec, and a recorded demo.

### NFR4 — Testability

1. THE SYSTEM SHALL support integration tests against a real PostgreSQL with RLS active (Testcontainers or a dev RDS).
2. THE SYSTEM SHALL include the cross-tenant isolation suite as a first-class, always-run test target (reinforces R6.6, R6.7).
3. THE SYSTEM SHALL support Stripe webhook testing via the Stripe CLI and fixtures in test mode (reinforces R10).

---

## Out of Scope (this spec)

- A full end-user web application (an optional thin admin SPA is deferred to V3 polish).
- Non-Stripe payment providers.
- Schema-per-tenant or database-per-tenant isolation models (evaluated and rejected — see ADR-001 in [`design.md`](./design.md)).
- Real-money/production Stripe processing.

---

## Traceability

Every requirement above is realized by one or more tasks in [`tasks.md`](./tasks.md) and designed
in [`design.md`](./design.md). The consolidated **Requirements Traceability Matrix** lives at the
end of [`tasks.md`](./tasks.md).
