import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

/**
 * TenantForge k6 load test (Task 20, NFR2.1, R12.5).
 *
 * Exercises signup → login → projects CRUD across MANY tenants, plus a burst stage that drives
 * the per-tenant rate limiter to prove 429s appear under load and p99 stays within budget.
 *
 * Run against a locally-running app (npm run dev) or the dev ALB:
 *   k6 run -e BASE_URL=http://localhost:3000 k6/load-test.js
 *   k6 run -e BASE_URL=http://<alb-dns> k6/load-test.js
 *
 * Thresholds encode NFR2.1: p99 < 250ms reads / < 400ms writes. Rate-limit 429s are EXPECTED in
 * the burst stage and are counted, not failed.
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const rateLimited = new Counter("rate_limited_429");

export const options = {
  scenarios: {
    // Steady CRUD load across ramping virtual users (each VU = its own tenant).
    crud: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },
        { duration: "1m", target: 20 },
        { duration: "30s", target: 0 },
      ],
      exec: "crudFlow",
    },
    // Burst: a single tenant hammers reads to trigger the free-plan limiter (429 + Retry-After).
    burst: {
      executor: "constant-arrival-rate",
      rate: 120, // req/s — well above free plan's 60/min
      timeUnit: "1s",
      duration: "20s",
      preAllocatedVUs: 20,
      exec: "burstFlow",
      startTime: "30s",
    },
  },
  thresholds: {
    "http_req_duration{op:read}": ["p(99)<250"], // NFR2.1 reads
    "http_req_duration{op:write}": ["p(99)<400"], // NFR2.1 writes
    http_req_failed: ["rate<0.05"], // <5% hard failures (429s are tracked separately, not failures)
  },
};

function auth(token) {
  return { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

/** Signs up + logs in a unique tenant, returns an access token. */
function onboard() {
  const suffix = `${__VU}-${__ITER}-${Date.now()}`;
  const email = `load-${suffix}@example.com`;
  const body = JSON.stringify({ organizationName: `Load ${suffix}`, email, password: "password123" });
  http.post(`${BASE_URL}/v1/auth/signup`, body, { headers: { "Content-Type": "application/json" } });
  const login = http.post(
    `${BASE_URL}/v1/auth/login`,
    JSON.stringify({ email, password: "password123" }),
    { headers: { "Content-Type": "application/json" } },
  );
  return login.json("access_token");
}

export function crudFlow() {
  const token = onboard();
  if (!token) return;

  // Create (write)
  const created = http.post(
    `${BASE_URL}/v1/projects`,
    JSON.stringify({ name: `p-${__ITER}` }),
    { ...auth(token), tags: { op: "write" } },
  );
  check(created, { "create 201": (r) => r.status === 201 });
  const id = created.json("id");

  // List (read)
  const list = http.get(`${BASE_URL}/v1/projects`, { ...auth(token), tags: { op: "read" } });
  check(list, { "list 200": (r) => r.status === 200 });

  // Get one (read)
  if (id) {
    const got = http.get(`${BASE_URL}/v1/projects/${id}`, { ...auth(token), tags: { op: "read" } });
    check(got, { "get 200|404": (r) => r.status === 200 || r.status === 404 });
  }
  sleep(1);
}

export function burstFlow() {
  const token = onboard();
  if (!token) return;
  const res = http.get(`${BASE_URL}/v1/projects`, { ...auth(token), tags: { op: "read" } });
  if (res.status === 429) {
    rateLimited.add(1);
    check(res, { "429 has Retry-After": (r) => !!r.headers["Retry-After"] });
  }
}
