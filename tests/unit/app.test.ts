import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import type { AppConfig } from "../../src/config";

/** Minimal valid config for unit tests — no DB/network needed for Task 1. */
const testConfig: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "silent" as AppConfig["LOG_LEVEL"],
  DATABASE_URL: "postgresql://unused",
  JWT_SIGNING_SECRET: "test-secret-that-is-at-least-32-bytes-long!!",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 1_209_600,
};

describe("Task 1 — skeleton, health, logging (R15.1, R15.2)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(testConfig);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200 {status:ok}", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("responses carry an x-request-id correlation header (R15.2)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("honors an inbound x-request-id for correlation propagation", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "corr-123" },
    });
    expect(res.headers["x-request-id"]).toBe("corr-123");
  });

  it("unmatched routes return the consistent error envelope (R14.4)", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.error.request_id).toBeTruthy();
  });

  it("CORS: preflight OPTIONS returns 204 with allow + expose headers (Task 22 SPA)", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/v1/projects" });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    // Rate-limit headers must be browser-readable for the SPA to display them.
    expect(res.headers["access-control-expose-headers"]).toContain("x-ratelimit-remaining");
  });

  it("serves the OpenAPI 3.1 spec at /openapi.json (R14.2)", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.info.title).toBe("TenantForge API");
  });

  it("serves Swagger UI at /docs (R14.2)", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/" });
    // Swagger UI returns HTML (200) or redirects to the static index.
    expect([200, 302]).toContain(res.statusCode);
  });
});

describe("Task 1 — structured JSON logs include request_id (R15.1)", () => {
  it("emits valid JSON log lines carrying reqId", async () => {
    // Capture stdout to assert log shape.
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    const app = buildApp({ ...testConfig, LOG_LEVEL: "info" });
    await app.ready();
    await app.inject({ method: "GET", url: "/health" });
    await app.close();

    process.stdout.write = originalWrite;

    const jsonLines = lines
      .flatMap((l) => l.split("\n"))
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l));

    expect(jsonLines.length).toBeGreaterThan(0);
    // At least one request-scoped log line carries a reqId.
    const withReqId = jsonLines.filter((o) => typeof o.reqId === "string");
    expect(withReqId.length).toBeGreaterThan(0);
  });
});
