# TenantForge

A production-grade **multi-tenant SaaS API platform** built to demonstrate the complete backend engineering stack: tenant isolation at the database layer, subscription billing with Stripe, distributed rate limiting, JWT auth with token rotation, and full AWS infrastructure automation via Terraform.

Organizations sign up, subscribe, and use a versioned REST API. Every request is isolated by **PostgreSQL Row Level Security** enforced on a non-privileged app role. The zero-leakage property is verified by an automated test suite that attempts cross-tenant reads, writes, and raw SQL — all return zero rows or are rejected.

> Built to the spec in [`.kiro/specs/tenantforge`](./.kiro/specs/tenantforge):
> [requirements](./.kiro/specs/tenantforge/requirements.md),
> [design](./.kiro/specs/tenantforge/design.md),
> [tasks](./.kiro/specs/tenantforge/tasks.md).

---

## Architecture Diagrams

Five hand-crafted SVG diagrams covering every layer of the system. Open any `.svg` directly in a browser for full-resolution, selectable text.

| Diagram | What it covers |
|---|---|
| [System Overview](./docs/diagrams/01-system-overview.svg) | AWS topology: WAF, ALB, ECS Fargate, RDS, ElastiCache, ECR, Secrets Manager, CloudWatch |
| [Request Lifecycle](./docs/diagrams/02-request-lifecycle.svg) | The full Fastify middleware stack: WAF, CORS, IP rate limit, authenticate, tenant rate limit, withTenant (GUC + RLS), handler, commit |
| [Data Model](./docs/diagrams/03-data-model.svg) | All 10 PostgreSQL tables, foreign keys, RLS policies, and index annotations |
| [Auth Flow](./docs/diagrams/04-auth-flow.svg) | 6 auth paths: signup, login, token refresh with family rotation, password reset, invitation, API key auth |
| [Billing Flow](./docs/diagrams/05-billing-flow.svg) | Checkout, customer portal, webhook sync (atomic dedup), write enforcement, plan quotas |

---

## Key Engineering Decisions

### Tenant Isolation (ADR-001)

Postgres RLS with `FORCE ROW LEVEL SECURITY` on every tenant-scoped table. The app role is created as `NOSUPERUSER NOBYPASSRLS`, making RLS unconditional. The GUC `app.current_tenant_id` is set as a transaction-local value (`set_config(..., true)`) so it cannot bleed across pooled connections. An unset GUC returns NULL from `NULLIF(current_setting(..., true), '')::uuid`, which means zero rows returned rather than an error — the system fails closed.

The isolation test suite covers three simultaneous tenants and exercises:
- API-level cross-tenant reads (expect 0 rows / 404)
- ORM-level cross-tenant writes (expect rejection)
- Raw SQL that omits the WHERE clause (RLS auto-filters)

See [ADR-001](./docs/adr/ADR-001-tenant-isolation.md).

### Idempotent Stripe Billing (ADR-004)

Webhook processing follows a strict sequence: verify HMAC signature, re-fetch the subscription from Stripe API (source of truth, not the payload), then in a single transaction insert the event ID into `processed_webhooks` (UNIQUE constraint as dedup guard), upsert `subscriptions`, update `organizations.plan`, and append to `audit_log`. A duplicate unique violation (pg code 23505) rolls back silently and returns `"duplicate"` — redelivery is a safe no-op. If the Stripe re-fetch fails, the transaction is never opened and Stripe retries on non-2xx.

Checkout uses `SELECT ... FOR UPDATE` on the organizations row to prevent duplicate Stripe customers under concurrent requests from the same tenant.

See [ADR-004](./docs/adr/ADR-004-billing-idempotency.md).

### Distributed Rate Limiting (ADR-003)

An atomic Lua token-bucket runs inside Redis via `EVALSHA`. The script reads the bucket state, refills based on elapsed time, decrements, and sets EXPIRE in a single atomic round-trip. This guarantees correctness across all Fargate tasks without a central coordinator. On Redis failure, writes fail closed (503) to protect the database; GET requests fail open for availability. Bucket configs: `free` 60/1s, `starter` 300/5s, `pro` 1000/16.7s. IP buckets apply before auth on credential routes (10/min) and general routes (30/min).

See [ADR-003](./docs/adr/ADR-003-rate-limiting.md).

### Auth Design (ADR-002)

Short-lived HS256 JWTs (max 900s, never stored server-side) carry `{ sub, tenant_id, role }`. Refresh tokens are 32-byte random values stored as SHA-256 hashes. They are organized into `family_id` groups: when a refresh token is rotated, the old token is marked `used_at` and a new one is inserted in the same family. If a `used_at` token is presented again outside a 10-second overlap window, the entire family is revoked and a 401 is returned, protecting against token theft. Password reset tokens are SHA-256 hashed, single-use, 1-hour TTL, and consuming one immediately revokes all active refresh sessions.

API keys have a `tf_` prefix, are stored as SHA-256 hashes only, and always grant `member` role regardless of the issuing user's role.

See [ADR-002](./docs/adr/ADR-002-auth-design.md).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Framework | Fastify 4 with Zod type provider |
| Validation | Zod (single source for schema and OpenAPI generation) |
| ORM / Migration | Drizzle ORM + Drizzle Kit |
| Database | PostgreSQL 16 (RDS db.t4g.micro) |
| Cache / Rate limit | Redis 7 (ElastiCache cache.t4g.micro) |
| Billing | Stripe (Checkout, Customer Portal, Webhooks) |
| Container | Docker, AWS ECS Fargate (256 CPU / 512 MiB) |
| Image registry | AWS ECR (scan_on_push enabled) |
| Infrastructure | Terraform (remote S3 state, no NAT Gateway) |
| CI | GitHub Actions: lint, typecheck, unit + integration tests, ECR push |
| CD | GitHub Actions: terraform apply, migration with rollback path, ECS deploy, smoke test, staging gate |
| Security | AWS WAF v2 (OWASP, SQLi, bad inputs), Secrets Manager, TLS 1.3, CORS |
| Observability | CloudWatch Logs (14-day retention), CloudWatch Alarms (5xx, p99, 4xx), SNS email |
| Testing | Vitest + Testcontainers (real Postgres + Redis, no mocks for integration) |
| Load testing | k6 (see [k6/](./k6/README.md)) |
| API docs | OpenAPI 3.1 auto-generated from Zod schemas, served at `/docs` (Swagger UI) |

---

## API Surface

All routes are versioned. `/v1` is frozen; `/v2` ships breaking changes concurrently.

| Method | Path | Auth | Min Role | Description |
|---|---|---|---|---|
| POST | /v1/auth/signup | None | — | Create organization + owner user |
| POST | /v1/auth/login | None | — | Return access + refresh token pair |
| POST | /v1/auth/refresh | None | — | Rotate refresh token (reuse detection) |
| POST | /v1/auth/password-reset/request | None | — | Issue reset token (uniform response, no enumeration) |
| POST | /v1/auth/password-reset/confirm | None | — | Apply new password, revoke sessions |
| POST | /v1/invitations | JWT | admin | Create invitation for team member |
| POST | /v1/invitations/accept | None | — | Accept invitation, create user |
| POST | /v1/projects | JWT/Key | member | Create project (write enforcement + quota check) |
| GET | /v1/projects | JWT/Key | member | List projects (cursor pagination) |
| GET | /v1/projects/:id | JWT/Key | member | Get project |
| PATCH | /v1/projects/:id | JWT/Key | member | Update project (write enforcement) |
| DELETE | /v1/projects/:id | JWT/Key | member | Archive project (write enforcement) |
| GET | /v2/projects | JWT/Key | member | List projects (camelCase, v2 envelope) |
| POST | /v1/billing/checkout | JWT | admin | Start Stripe Checkout session |
| POST | /v1/billing/portal | JWT | admin | Open Stripe Customer Portal |
| POST | /webhooks/stripe | HMAC | — | Idempotent Stripe event processing |
| POST | /v1/api-keys | JWT | admin | Create API key (plaintext returned once) |
| GET | /v1/api-keys | JWT | admin | List API keys (no plaintext) |
| DELETE | /v1/api-keys/:id | JWT | admin | Revoke API key |
| POST | /v1/exports | JWT | admin | Full tenant data export (strips secret columns) |
| DELETE | /v1/tenant | JWT | owner | Soft-delete organization |
| GET | /health | None | — | Health check |
| GET | /openapi.json | None | — | OpenAPI 3.1 spec |
| GET | /docs | None | — | Swagger UI |

---

## Local Development

### Prerequisites

- Node.js 20+
- Docker (for Postgres and Redis)
- An `.env` file (copy from `.env.example`)

### Setup

```bash
npm ci

# Start Postgres and Redis
docker run -d -p 5432:5432 \
  -e POSTGRES_PASSWORD=owner_pw \
  -e POSTGRES_USER=tenantforge_migrator \
  -e POSTGRES_DB=tenantforge \
  postgres:16-alpine

docker run -d -p 6379:6379 redis:7-alpine

# Configure environment
cp .env.example .env
# Fill in: DATABASE_URL, MIGRATION_DATABASE_URL, JWT_SIGNING_SECRET (min 32 chars)

# Run migrations (creates tables, app role, RLS policies)
npm run db:migrate

# Start dev server
npm run dev
# => http://localhost:3000/health
# => http://localhost:3000/docs  (Swagger UI)
```

### Available Commands

```bash
npm run dev          # Start with hot reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled output
npm test             # Full unit + integration suite (Testcontainers)
npm run rls-lint     # Fail if any tenant-scoped table lacks an RLS policy
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run db:migrate   # Apply all pending Drizzle migrations
npm run db:generate  # Generate new migration from schema changes
```

---

## Testing

```bash
npm test
```

Integration tests use **Testcontainers** to spin up real Postgres and Redis instances. No mocks for the persistence layer. The test suite runs sequentially to avoid port conflicts.

The signature deliverable is `tests/integration/isolation.test.ts`: three tenants are created and each one attempts to read or write data belonging to the others. Every cross-tenant attempt must return zero rows or be rejected by the database. Any failure here is a critical security regression.

```bash
npm run rls-lint     # Separate guard: fails CI if a new table was added without an RLS policy
```

Load testing lives in [`k6/`](./k6/README.md).

---

## Infrastructure and Deployment

Terraform modules in [`infra/`](./infra/). Each environment (`dev`, `staging`, `prod`) is a thin root that sources the shared `infra/modules/stack` composition module.

### AWS Resources

| Module | Resources |
|---|---|
| `vpc` | VPC 10.0.0.0/16, public + private subnets across 2 AZs, VPC endpoints (no NAT Gateway) |
| `alb` | Internet-facing ALB, HTTP redirect, HTTPS TLS 1.3, `/health` target group |
| `waf` | WAFv2 WebACL: AWSManagedRulesCommonRuleSet, SQLiRuleSet, KnownBadInputsRuleSet |
| `ecs` | Fargate cluster, task definition (256 CPU / 512 MiB), service, CloudWatch log group |
| `rds` | PostgreSQL 16, db.t4g.micro, encrypted, private subnets only |
| `elasticache` | Redis 7.1, cache.t4g.micro, private subnets only |
| `secrets` | Single Secrets Manager JSON secret with all app credentials |
| `iam` | ECS execution role (ECR pull + Secrets Manager read), task role |
| `ecr` | ECR repository with scan_on_push |
| `cloudwatch` | Log groups, ALB 5xx / p99 / 4xx alarms, SNS topic for email alerts |
| `static-site` | S3 + CloudFront for admin SPA (opt-in per environment) |

### VPC Cost Optimization

NAT Gateway costs approximately $32/month. This project avoids it entirely by using VPC endpoints: interface endpoints for `ecr.api`, `ecr.dkr`, `secretsmanager`, and `logs`; a free gateway endpoint for S3 (ECR image layer pulls). All private resources reach AWS services without leaving the VPC.

### CI/CD Pipeline

**CI** (`.github/workflows/ci.yml`) on every push to `main` and all PRs:
1. Lint + typecheck
2. Unit tests
3. Integration tests (Testcontainers)
4. RLS lint
5. Docker build
6. ECR push (main branch only)

**CD** (`.github/workflows/cd.yml`) on push to `main` after CI passes:
1. `terraform apply` (remote S3 + DynamoDB lock state)
2. Run migrations with automatic rollback on failure
3. ECS deploy (force new deployment)
4. Smoke test (`/health` endpoint)
5. Manual approval gate before promoting to production

### Bootstrap Remote State

```bash
cd infra/bootstrap
terraform init && terraform apply
# Creates: S3 bucket (versioned) + DynamoDB table for state locking
```

### Deploy to Dev

```bash
cd infra/envs/dev
cp dev.tfvars.example dev.tfvars  # fill secrets
terraform init
terraform apply -var-file=dev.tfvars
```

### Teardown (cost control)

```bash
terraform -chdir=infra/envs/dev destroy
```

> **Status:** application verified end-to-end against real Postgres + Redis. IaC and pipelines are written and `terraform validate`-clean but not yet applied to a live AWS account (requires credentials and running the bootstrap stack first).

---

## Estimated Running Cost

| Component | Instance | Monthly |
|---|---|---|
| RDS PostgreSQL | db.t4g.micro | ~$13 |
| ElastiCache Redis | cache.t4g.micro | ~$12 |
| ECS Fargate | 0.25 vCPU / 0.5 GB, 1 task | ~$9 |
| ALB | 1 load balancer | ~$16 (tear down between demos) |
| NAT Gateway | Not used (VPC endpoints instead) | $0 (saves ~$32/mo) |
| **Total** | | **~$50/mo** (with ALB); **~$34 without** |

---

## Portfolio Assets (Case Study Checklist)

- [ ] Screenshot: isolation test suite passing (cross-tenant attempts return 0 rows).
- [ ] Screenshot: Stripe test-mode subscription + webhook log (idempotent duplicate handling visible).
- [ ] Screenshot: 429 response with `Retry-After` + `X-RateLimit-*` under k6 burst load.
- [ ] Screenshot: CloudWatch dashboard (error rate, p99, 429 rate) with an alarm firing to SNS.
- [ ] k6 summary table (throughput, p99 read/write) in [`k6/README.md`](./k6/README.md).
- [ ] Short demo video: signup → subscribe → CRUD → rate-limit flow.

---

## Architecture Decision Records

- [ADR-001 Tenant Isolation](./docs/adr/ADR-001-tenant-isolation.md) — RLS design, GUC approach, fail-closed behavior
- [ADR-002 Auth Design](./docs/adr/ADR-002-auth-design.md) — JWT TTL, refresh token families, API key hashing
- [ADR-003 Rate Limiting](./docs/adr/ADR-003-rate-limiting.md) — Lua token bucket, Redis fail modes, plan tiers
- [ADR-004 Billing Idempotency](./docs/adr/ADR-004-billing-idempotency.md) — Webhook dedup ledger, Stripe re-fetch pattern
