# Load Testing (k6)

`load-test.js` exercises TenantForge under load to validate NFR2.1 (p99 latency) and R12.5
(per-tenant rate limits hold under concurrency).

## What it does

- **`crud` scenario** — ramps to 20 virtual users, each acting as its own tenant (signup → login
  → create/list/get projects). Tagged `op:read` / `op:write` so thresholds apply per operation.
- **`burst` scenario** — a constant 120 req/s stream that drives a free-plan tenant past its
  60 req/min bucket, so `429`s appear with a `Retry-After` header (counted in `rate_limited_429`).

## Thresholds (fail the run if breached)

| Metric | Budget (NFR2.1) |
|---|---|
| `http_req_duration{op:read}` p99 | < 250 ms |
| `http_req_duration{op:write}` p99 | < 400 ms |
| `http_req_failed` rate | < 5% (429s tracked separately, not counted as failures) |

## Running

Start the app with Redis so the limiter is active:

```bash
# terminal 1 — Postgres + Redis (or use the dev ALB)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=... postgres:16-alpine
docker run -d -p 6379:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6379
npm run db:migrate && npm run dev

# terminal 2 — run the load test
k6 run -e BASE_URL=http://localhost:3000 k6/load-test.js
```

Against the deployed dev ALB: `k6 run -e BASE_URL=http://<alb-dns> k6/load-test.js`.

## Baseline (record here after a run)

> Fill in from an actual `k6 run` on the target environment. Provisional targets come from
> NFR2.1; update with justification if the measured baseline differs.

| Metric | Target | Measured |
|---|---|---|
| Throughput (crud) | ≥ 200 req/s | _TBD_ |
| p99 read latency | < 250 ms | _TBD_ |
| p99 write latency | < 400 ms | _TBD_ |
| `429` under burst | > 0 (limiter holds) | _TBD_ |
| http_req_failed | < 5% | _TBD_ |

Capture the k6 summary table as a portfolio asset (§ case-study checklist in the top-level README).
