# TenantForge — Implementation Tasks

> **Spec:** `tenantforge`
> **Status:** Draft (v1)
> **Related:** [`requirements.md`](./requirements.md) · [`design.md`](./design.md)

## How to use this document

Tasks are grouped into four phases (**MVP → V1 → V2 → V3**) that map to the roadmap in the source
brief. Each task is **test-driven**: write the test(s) first, then the implementation, then verify.
Every task lists the requirements it satisfies (`→ R#`), the design section it implements (`§#`), and
a **Demo** line — a concrete, observable outcome that proves the task is done. Complete tasks in order;
each phase ends with an integrated, demoable increment.

**Legend:** `→ R#` requirement · `§#` design section · ☐ not started.

---

## Phase MVP (Weeks 1–2) — prove the core loop

> Goal: signup → login → tenant-scoped CRUD, plus team management (invitations/roles) and
> credential recovery (password reset), with **RLS enabled from day one**.
> **Do NOT postpone RLS** (retrofitting isolation later is painful). **Postpone** Stripe, rate
> limiting, CI/CD, and WAF to later phases.

### ☐ Task 1: Project skeleton + structured logging
- **Objective:** Bootstrap the Fastify + TypeScript project with structured JSON logging and a health check.
- **Implementation:** Fastify app; `pino` JSON logs with a per-request correlation id (`request_id`) generated in an `onRequest` hook; `GET /health` returns `200`; strict `tsconfig`; ESLint + Prettier; `.env.example` (no secrets committed).
- **Tests:** unit test asserting `/health` returns `200`; test asserting every log line is valid JSON and includes `request_id`.
- **→** R15.1, R15.2, NFR1 · **§** 1, 9.3
- **Demo:** `curl /health` returns `200`; logs show a JSON line with a `request_id`.

### ☐ Task 2: Drizzle schema + migrations with tenant_id + RLS from day one
- **Objective:** Define the initial schema and ship RLS on the first migration.
- **Implementation:** Drizzle schema for `organizations`, `users` (incl. `email_verified` default false), `projects` (per §3.2/§3.3), UUID PKs, `tenant_id` not null, `tenant_id`-leading composite indexes. Migration also runs the §4.1 role setup (`tenantforge_migrator`, `tenantforge_app` with `NOSUPERUSER NOBYPASSRLS`) and the §4.2 `ENABLE` + `FORCE` RLS policies on `users` and `projects`. Configure two connection strings: migrator (migrations) and app (runtime). (Tenant-scoped `invitations` and `auth_tokens` tables + policies are added with their features in Tasks 6b and 15b.)
- **Tests:** integration test (real Postgres via Testcontainers) asserting RLS is enabled + forced on `projects`; assert the app role lacks `BYPASSRLS`.
- **→** R6.1, R6.2, R6.3, R17 (schema), R18.2 (roles) · **§** 3, 4
- **Demo:** `drizzle-kit migrate` provisions the schema; `\d+ projects` shows RLS forced; app role query without tenant context returns zero rows / errors (fails closed).

### ☐ Task 3: Signup provisioning (transactional)
- **Objective:** Self-service signup creates an organization + owner user atomically.
- **Implementation:** `POST /v1/auth/signup` (Zod-validated); within one transaction create `organizations` (default plan `free`, generated `slug`) + owner `users` (Argon2id hash); write `audit_log` `org.created`. Duplicate email within a tenant → `409`.
- **Tests:** unit (password hashing never returns plaintext); integration (successful signup creates exactly one org + one owner; forced failure mid-transaction leaves zero rows — rollback).
- **→** R1.1–R1.6, R16.1 · **§** 3, 9.3
- **Demo:** signup returns the new org + owner; a deliberately failing provision leaves no orphan rows.

### ☐ Task 4: Login issues access + refresh JWT
- **Objective:** Credentialed login returns a short access token and a refresh token.
- **Implementation:** `POST /v1/auth/login`; verify Argon2id hash; issue access JWT (≤15 min: `sub`, `tenant_id`, `role`) + refresh token (random, stored hashed with a new `family_id`). JWT signing key read from env/Secrets Manager (never committed). (Full rotation/reuse detection lands in V2 Task 15 — MVP issues + verifies only.)
- **Tests:** unit (access token carries correct claims; expiry ≤15 min; invalid signature rejected); integration (login returns both tokens; refresh token persisted only as a hash).
- **→** R3.1, R3.2, R3.5, R3.7 · **§** 8
- **Demo:** login returns an access + refresh token; the DB stores only the refresh hash; tampered token → `401`.

### ☐ Task 5: Tenant-context middleware (RLS binding)
- **Objective:** Bind each authenticated request to a transaction-local tenant context.
- **Implementation:** auth preHandler verifies the access JWT and sets `req.auth.tenantId`; `withTenant` preHandler (per §5.2) acquires a connection, `BEGIN`, `set_config('app.current_tenant_id', $1, true)`, attaches `req.db`, and commits/rolls back + `RESET` + releases in the finish/finally cleanup. Missing tenant context → `403`/fail-closed.
- **Tests:** integration proving two sequential requests on the same pooled connection do **not** leak tenant context (connection reuse test); missing-context request fails closed.
- **→** R6.4, R6.5, R6.8, R6.9 · **§** 5
- **Demo:** requests run under the correct tenant; a pooled connection reused by a second tenant shows no bleed.

### ☐ Task 6: `projects` CRUD scoped by tenant
- **Objective:** Full CRUD for the demo resource, tenant-stamped and RLS-protected.
- **Implementation:** `/v1/projects` create/read/list/update/delete; `tenant_id` stamped from the token (never the body); UUID ids; list returns only the caller's rows; mutations write `audit_log`; unknown-or-other-tenant id → `404`.
- **Tests:** integration for each verb; assert create ignores a body-supplied `tenant_id`; assert `404` for a foreign id.
- **→** R8.1–R8.6, R16.1 · **§** 3, 9.2, 9.3
- **Demo:** create/list/update/delete projects for a tenant; a body-injected `tenant_id` is ignored.

### ☐ Task 6b: Team management (invitations + role assignment) & credential recovery
- **Objective:** Make RBAC meaningful (multi-user tenants) and support password reset — closing the two biggest MVP gaps.
- **Implementation:** add tenant-scoped `invitations` and `auth_tokens` tables (+ `ENABLE`/`FORCE` RLS per §4). Endpoints: `POST /v1/invitations` (owner/admin only), `POST /v1/invitations/accept`; role-change endpoint with the **last-owner guard** (§8.3); `POST /v1/auth/password-reset/request` (uniform response, no enumeration), `POST /v1/auth/password-reset/confirm` (rotates password hash + revokes refresh families); optional email-verify confirm flipping `users.email_verified`. Tokens stored hashed only; audit entries on invite/role-change/reset.
- **Tests:** unit (last-owner guard rejects removing final owner `409`; expired/consumed invitation → `410`; reset request returns identical shape whether or not the email exists); integration (invited member lands in the correct tenant under RLS; a completed reset revokes existing refresh families).
- **→** R20.1–R20.7, R22.1–R22.7, R4 · **§** 3, 4, 8.3, 8.4
- **Demo:** an owner invites a member who accepts and sees only that tenant's projects; removing the last owner is blocked; a password reset logs out old sessions.

### ☐ Task 7: First cross-tenant isolation assertion
- **Objective:** Establish the isolation test as a first-class, always-run target.
- **Implementation:** seed **three** tenants; a test authenticated as Tenant A attempts to read Tenant B's projects via the API and asserts zero rows. (Expanded to raw-SQL + write attempts in V1 Task 8.)
- **Tests:** the assertion above wired into the default `npm test` target.
- **→** R6.6 (initial), NFR4.2 · **§** 4, 5
- **Demo:** with 3 tenants seeded, Tenant A's list never contains Tenant B's data; test is green.

> **MVP exit criteria:** two tenants each see only their own projects; a cross-tenant read returns
> zero rows; RLS is forced on a non-`BYPASSRLS` app role. Manual deploy is acceptable at this stage.

---

## Phase V1 (Weeks 3–5) — isolation proof + IaC + CI/CD

> Goal: the **signature deliverable** (full isolation suite) plus reproducible infra and an automated
> pipeline that runs migrations. **Don't skip** migrations-in-CI, Secrets Manager, or remote TF state.

### ☐ Task 8: Full cross-tenant isolation test suite (signature deliverable)
- **Objective:** Prove zero cross-tenant leakage across every access path.
- **Implementation:** exhaustive suite over 3 tenants covering: API reads/writes; ORM queries; **raw SQL on the app connection**; INSERT/UPDATE attempting another tenant's `tenant_id` (blocked by `WITH CHECK`); missing-context fail-closed; `audit_log` scoping. Add a CI job that fails the build if any table is tenant-scoped without an RLS policy (schema/registry lint per §3.2).
- **Tests:** this *is* the test suite; every case asserts zero rows / rejected write.
- **→** R6.6, R6.7, R6.8, R16.2, NFR4.2 · **§** 3, 4, 5
- **Demo:** full suite green; screenshot of cross-tenant attempts → 0 rows / rejected writes (portfolio asset).

### ☐ Task 9: Terraform foundation + remote state
- **Objective:** Reproducible infrastructure as code.
- **Implementation:** Terraform modules — VPC (private subnets for RDS/Redis) **using VPC Gateway/Interface Endpoints (S3, ECR, Secrets Manager, CloudWatch Logs) instead of a managed NAT Gateway** to hold the cost target (NFR3.2), RDS PostgreSQL (`db.t4g.micro`), ECS Fargate service + ALB, IAM (least-privilege per component), Secrets Manager (DB creds, JWT key placeholder). Remote state in S3 + DynamoDB lock. Parameterize for `dev`/`staging`/`prod`.
- **Tests:** `terraform validate` + `plan` in CI; a policy check (e.g. tflint/checkov) for obvious misconfig; assert no plaintext secrets in state config.
- **→** R17.1, R17.2, R17.3, R17.4, NFR3.1, NFR3.2 · **§** 1, 2, 11
- **Demo:** `terraform apply` stands up VPC + RDS + Fargate + ALB; state is in S3 with a DynamoDB lock.

### ☐ Task 10: Containerize + GitHub Actions build/test/push
- **Objective:** CI that lints, tests, builds, and pushes an image.
- **Implementation:** multi-stage Dockerfile (small runtime image, non-root user); GitHub Actions: `lint → test (incl. isolation suite) → build → push to ECR`. Fail the pipeline if the isolation suite fails.
- **Tests:** the pipeline itself; a smoke unit test that the built image boots and `/health` responds.
- **→** R18.1, NFR4 · **§** 1
- **Demo:** a push builds and pushes a tagged image to ECR with all tests (including isolation) green.

### ☐ Task 11: CD — migrate (with rollback) → deploy → smoke test
- **Objective:** Automated deploy that runs migrations safely and verifies health.
- **Implementation:** pipeline continues `terraform apply → run DB migrations as the migrator role with a rollback path → deploy ECS task → smoke test`. On smoke failure, surface it and support rollback to the last healthy task/migration.
- **Tests:** a staging deploy dry-run; a deliberately failing smoke test proves the rollback path.
- **→** R18.2, R18.3, R18.5 · **§** 4.3
- **Demo:** one push deploys to AWS with CI-run migrations; a forced bad deploy triggers the documented rollback.

> **V1 exit criteria:** green isolation suite + one-command AWS deploy with migrations run in CI and
> a working rollback path.

---

## Phase V2 (Weeks 6–9) — billing + rate limiting + versioning + auth hardening

> Goal: the revenue + protection + evolution features that make this a real SaaS platform.

### ☐ Task 12: Stripe subscriptions + Customer Portal
- **Objective:** Tenants can subscribe and self-manage plans (test mode).
- **Implementation:** create/reuse Stripe customer, persist `stripe_customer_id`; Checkout to start a subscription; Customer Portal session endpoint; on activation set `organizations.plan` + `subscriptions.status`. Stripe **test mode** only.
- **Tests:** integration against Stripe test mode (or mocked client) for customer creation + portal session; unit for plan→entitlement mapping.
- **→** R9.1, R9.2, R9.3, R9.4 · **§** 7
- **Demo:** a tenant subscribes in test mode and opens the Customer Portal; plan flips to the paid tier.

### ☐ Task 13: Signed + idempotent webhook handler
- **Objective:** Tamper-proof, redelivery-safe, out-of-order-tolerant webhooks.
- **Implementation:** raw-body route; `constructEvent` signature + timestamp verification; insert `event.id` into `processed_webhooks` (UNIQUE) **before** business logic (duplicate → `200` no-op); **refetch** the object from the Stripe API; sync `subscriptions.status` + `organizations.plan`; `invoice.payment_failed` → `past_due` + dunning; fast ack.
- **Tests:** Stripe CLI fixtures: valid event processes once; **redelivered event is a no-op** (ledger dedup); forged signature → `400`, no mutation; out-of-order events converge to correct state via refetch.
- **→** R10.1–R10.7, R11.1 · **§** 7
- **Demo:** Stripe test-mode subscription lifecycle; webhook log shows a redelivered event handled idempotently (portfolio asset).

### ☐ Task 14: ElastiCache Redis + atomic Lua token-bucket limiter
- **Objective:** Per-tenant rate limiting that holds across all tasks.
- **Implementation:** add ElastiCache Redis (Terraform); implement the §6.1 Lua script (refill+check+decrement atomically); limiter preHandler keyed by `tenant_id`, capacity/refill from plan; return `X-RateLimit-*` on allow, `429` + `Retry-After` on deny. Add **pre-auth/IP-based limiting** (§6.3) for signup/login/password-reset/invite-accept keyed by trusted-proxy IP (stricter on credential routes), and **exempt the Stripe `/webhook` route** entirely. Implement the §6.4 fail policy: fail-closed (`503`) on writes/auth-adjacent, fail-open on `GET`, emit `ratelimiter_degraded`.
- **Tests:** unit for refill math (time-based); concurrency test proving no per-instance over-count; integration asserting headers + `429`; **IP-limit test on login brute-force**; assert `/webhook` is not tenant/IP limited; fail-policy tests (Redis down → `503` on write, allow on `GET`).
- **→** R12.1–R12.6, R23.1–R23.5, NFR2.3 · **§** 6
- **Demo:** under concurrent load a tenant hits `429` with correct `Retry-After`/`X-RateLimit-*` headers; limit holds across two app instances.

### ☐ Task 15: Plan enforcement (degraded-access matrix + quotas) + refresh rotation with reuse detection
- **Objective:** Enforce plan on the request path and harden auth.
- **Implementation:** plan/quota middleware implementing the **R11.1 degraded-access matrix** (`past_due`/`canceled` → reads allowed, writes `402`, billing/auth always on, rate ceiling dropped to `free`); **plan resource quotas (R21)** — active `projects` ≤ free 3 / starter 25 / pro unlimited, over-quota create → `403 QUOTA_EXCEEDED`; entitlements from persisted state. Complete `POST /v1/auth/refresh` rotation (mark old `used_at`, issue new token in same `family_id`); reuse of a used/revoked token revokes the whole family + `401`; optional rotation-overlap window. Implement the refresh-token-under-RLS lookup per design §5.2 (narrow lookup by `hashed_token`).
- **Tests:** unit (reuse detection revokes family; overlap window tolerates one retry; quota ceiling per plan); integration (`past_due` tenant: read ok, write `402`; free tenant blocked at 4th project `403 QUOTA_EXCEEDED`).
- **→** R3.3, R3.4, R3.6, R4, R11.1–R11.3, R21.1–R21.4 · **§** 8, 6.5
- **Demo:** replaying a used refresh token logs the whole session family out; a `past_due` tenant is restricted.

### ☐ Task 16: API versioning (/v2 breaking change) + X-Ray tracing
- **Objective:** Prove the versioning strategy and add distributed tracing.
- **Implementation:** freeze `/v1`; add `/v2` with a deliberate breaking change (e.g. renamed field or new pagination shape) as a separate plugin tree; both served concurrently. Add X-Ray spans across auth → rate limit → plan → handler → DB, carrying the `request_id`.
- **Tests:** contract tests asserting `/v1` response shape is unchanged while `/v2` reflects the breaking change; a trace-propagation test for the correlation id.
- **→** R13.1–R13.3, R15.2, R15.3 · **§** 9.1, 2
- **Demo:** `/v1` and `/v2` both respond with their distinct contracts; a request's spans appear in X-Ray linked by `request_id`.

> **V2 exit criteria:** subscription lifecycle survives webhook redelivery; `429` with correct
> headers under load; `/v1` and `/v2` coexist; refresh-token reuse revokes the family.

---

## Phase V3 (Weeks 10–12) — hardening, observability & docs

> Goal: production polish, monitoring, environment promotion, and the portfolio case-study assets.

### ☐ Task 17: WAF + edge hardening
- **Objective:** Block OWASP Top 10 categories at the edge.
- **Implementation:** attach WAF with OWASP managed rule group to ALB (and CloudFront if used) via Terraform; enforce TLS at the edge; reject plaintext HTTP; secure headers (HSTS, etc.).
- **Tests:** a probe request matching a managed rule is blocked; HTTP → HTTPS redirect/reject verified.
- **→** R19.1, R19.3, NFR1.1 · **§** 11
- **Demo:** a malicious probe is blocked by WAF; HTTP is rejected.

### ☐ Task 18: CloudWatch alarms → SNS
- **Objective:** Get paged on the signals that matter.
- **Implementation:** CloudWatch metrics + alarms for error rate, p99 latency, and `429` spike, wired to an SNS topic; a minimal dashboard.
- **Tests:** synthetic breach of a threshold fires the alarm to SNS (in a test environment).
- **→** R15.4, R19.2 · **§** 11
- **Demo:** a forced error-rate breach pages via SNS; dashboard shows error rate / p99 / 429 (portfolio asset).

### ☐ Task 19: Staging environment + promotion gate
- **Objective:** dev → staging → prod parity with a gate.
- **Implementation:** parameterized Terraform workspaces/vars for `staging` and `prod`; pipeline promotes through `staging` (runs migrations + smoke) before `prod`; `staging` gates `prod`.
- **Tests:** a change flows dev → staging (auto) → prod (gated); migrations run in each environment.
- **→** R18.4 · **§** 1, 4.3
- **Demo:** a commit promotes through staging into prod behind an approval gate.

### ☐ Task 20: k6 load test + documented baseline
- **Objective:** Quantify throughput and prove rate limits hold under load.
- **Implementation:** k6 scenarios exercising CRUD + the limiter across tenants; record baseline throughput and p99, and confirm limits hold (no over-count) and `429`s behave.
- **Tests:** the k6 run itself; assert p99 within target and rate-limit behavior under load.
- **→** NFR2.1, R12.5 · **§** 6
- **Demo:** k6 report showing baseline throughput, p99, and correct `429` behavior under load (portfolio asset).

### ☐ Task 21: ADRs, README, runbook + case-study assets
- **Objective:** Make the project legible and demoable, and control cost.
- **Implementation:** finalize ADR-001..004 (from §10); README with the architecture diagram, cost breakdown (~$10–15/mo), and a teardown runbook (`terraform destroy` between demos, keep repo + diagrams + committed `openapi.json` + recorded demo). Capture the four portfolio assets (isolation suite green, Stripe idempotent webhook log, `429` headers under k6, CloudWatch dashboard) + a short demo video.
- **Tests:** doc review checklist; verify `openapi.json` is committed and current.
- **→** NFR3.1, NFR3.2, R14.2 · **§** 10, 11
- **Demo:** README renders the diagram + cost + runbook; all four case-study screenshots + demo video captured.

### ☐ Task 21b: Tenant data export (compliance)
- **Objective:** Owner/admin can export all of their tenant's data (GDPR/portability).
- **Implementation:** `POST /v1/exports` (owner/admin) that iterates the tenant-scoped-table registry (design §3.2) under RLS, excludes secret material (password hashes, hashed tokens/keys), and produces a machine-readable archive; audit-logged.
- **Tests:** integration asserting the export contains only the acting tenant's rows across all registered tables and excludes secret columns; a registry-drift test (a new tenant-scoped table missing from the registry fails CI, reusing the Task 8 lint).
- **→** R24.1–R24.4, R16 · **§** 3.2, 11
- **Demo:** an owner exports their org; the archive covers every tenant table, contains no other tenant's rows, and omits secrets.

### ☐ Task 22 (optional): Thin admin SPA
- **Objective:** A visual demo surface.
- **Implementation:** minimal React SPA on S3 + CloudFront calling the API (login, list projects, show subscription + rate-limit headers). Uses the **separate** admin/tenant auth boundaries from R7 where it touches cross-tenant views.
- **Tests:** e2e smoke (login → list projects) against a deployed environment.
- **→** R7 (admin boundary), R8 · **§** 2, 9
- **Demo:** a browser demo showing tenant-scoped projects and live rate-limit headers.

> **V3 exit criteria:** CloudWatch dashboard + k6 report + staging→prod promotion + complete
> case-study artifacts; project tears down cleanly to control cost.

---

## Guardrails — what to avoid (from the source brief)

1. **No bare CRUD with no deployment.** Isolation, billing, and rate limiting are the point — not a plain resource API.
2. **RLS, not just app-level `WHERE tenant_id = ?`.** Database enforcement on a non-`BYPASSRLS` role is the differentiator (R6, ADR-001).
3. **Don't skip webhook idempotency.** "Handled the webhook" is table stakes; "safe under redelivery + out-of-order" is the signal (R10, ADR-004).
4. **Don't leave it running.** Tear down between demos (`terraform destroy`); keep the artifacts (NFR3).
5. **Don't run migrations on the app role or with RLS on the migration connection.** Use the migrator role (R18.2, §4.3).
6. **Never trust client-supplied `tenant_id`, role, or plan.** Derive from verified token / persisted state only (R4.4, R8.2, R11.3).

---

## Requirements Traceability Matrix

Every requirement is realized by at least one task; every task traces to at least one requirement.

| Requirement | Tasks |
|---|---|
| R1 Signup & provisioning | 3 |
| R2 Tenant lifecycle / soft delete | 3, 9 (roles), 19 |
| R3 JWT + refresh rotation | 4, 15 |
| R4 RBAC | 6b, 15 |
| R5 API keys | 15 (pattern), 6 (auth path) |
| R6 RLS isolation (incl. signature R6.6/R6.7) | 2, 5, 7, 8 |
| R7 Admin isolation | 8 (audit scope), 22 |
| R8 `projects` CRUD | 6 |
| R9 Stripe subscriptions | 12 |
| R10 Signed + idempotent webhooks | 13 |
| R11 Plan enforcement (degraded-access matrix) | 13, 15 |
| R12 Rate limiting | 14, 20 |
| R13 API versioning | 16 |
| R14 Pagination / error contract / OpenAPI | 1, 6, 16 |
| R15 Logging / tracing / metrics | 1, 16, 18 |
| R16 Audit trail | 3, 6, 8, 21b |
| R17 IaC | 9 |
| R18 CI/CD + migrations + promotion | 10, 11, 19 |
| R19 Edge security + alarms | 17, 18 |
| R20 User invitation & role assignment | 6b |
| R21 Plan quotas | 15 |
| R22 Password reset & email verification | 6b |
| R23 Pre-auth / IP rate limiting | 14 |
| R24 Tenant data export | 21b |
| NFR1 Security | 1, 3, 17 |
| NFR2 Performance / scalability | 2 (indexes), 14, 20 |
| NFR3 Cost / teardown (incl. no-NAT) | 9, 21 |
| NFR4 Testability | 2, 7, 8, 13 |

> **Coverage check:** R1–R24 and NFR1–NFR4 each map to ≥1 task above, and every task (1–22 plus
> 6b, 21b) cites ≥1 requirement. No orphaned tasks; no uncovered requirements. IDs R20–R24 and
> Tasks 6b/21b were added in the v1.1 revision; task numbering is intentionally non-contiguous to
> keep existing references stable.
