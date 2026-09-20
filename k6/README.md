# Load Testing with k6

`load-test.js` exercises TenantForge under realistic and burst traffic to validate two NFRs:

- **NFR2.1** — p99 latency: reads under 250ms, writes under 400ms at target throughput.
- **R12.5** — per-tenant rate limits hold correctly under concurrency (429s appear when a free-plan tenant exceeds 60 req/min).

---

## Scenarios

### `crud` — Realistic traffic

Ramps to 20 virtual users over 30 seconds. Each VU acts as its own tenant: it signs up, logs in, then runs a loop of `POST /v1/projects` (write) and `GET /v1/projects` (read). Operations are tagged `op:write` and `op:read` so p99 thresholds can be applied per operation type.

### `burst` — Rate limit validation

A constant injection of 120 req/s from a single tenant (free plan, 60 req/min bucket). Once the bucket drains, all requests receive `429 Too Many Requests` with a `Retry-After` header. The test counts 429s in a custom metric `rate_limited_429` and asserts that at least one appears — proving the limiter is active.

---

## Pass/Fail Thresholds

| Metric | Threshold | Rationale |
|---|---|---|
| `http_req_duration{op:read}` p99 | under 250ms | NFR2.1 read budget |
| `http_req_duration{op:write}` p99 | under 400ms | NFR2.1 write budget |
| `http_req_failed` rate | under 5% | 429s tracked separately, not counted as failures |
| `rate_limited_429` count | at least 1 | Confirms rate limiter fires under burst |

---

## Running the Tests

Start the app with Redis active (rate limiting requires Redis):

```bash
# Terminal 1: start dependencies
docker run -d -p 5432:5432 \
  -e POSTGRES_PASSWORD=owner_pw \
  -e POSTGRES_USER=tenantforge_migrator \
  -e POSTGRES_DB=tenantforge \
  postgres:16-alpine

docker run -d -p 6379:6379 redis:7-alpine

export REDIS_URL=redis://localhost:6379
npm run db:migrate
npm run dev

# Terminal 2: run the load test
k6 run -e BASE_URL=http://localhost:3000 k6/load-test.js
```

Against a deployed ALB:

```bash
k6 run -e BASE_URL=http://<alb-dns-name> k6/load-test.js
```

### Install k6

```bash
# macOS
brew install k6

# Linux
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker
docker run --rm -i grafana/k6 run - <k6/load-test.js
```

---

## Baseline Results

> Record the output of an actual `k6 run` here after executing against the target environment. Provisional targets come from NFR2.1. Update this table with measured values and note the environment (local Docker, dev ALB, etc.).

| Metric | Target | Measured | Environment |
|---|---|---|---|
| Throughput (crud scenario) | 200+ req/s | TBD | |
| p99 read latency | under 250ms | TBD | |
| p99 write latency | under 400ms | TBD | |
| 429s under burst | at least 1 | TBD | |
| http_req_failed rate | under 5% | TBD | |

---

## What to Capture for Portfolio

The k6 summary table printed at the end of a run is a strong portfolio asset. Record it here along with a screenshot of:

1. The `429` response in the k6 output with the `Retry-After` header visible.
2. The CloudWatch dashboard showing the 429 spike during the burst scenario.
3. The p99 values confirming the latency budget was met.

See the main [README case-study checklist](../README.md#portfolio-assets-case-study-checklist) for the full list.
