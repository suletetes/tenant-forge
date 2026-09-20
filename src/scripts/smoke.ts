/**
 * Post-deploy smoke test (R18.3). Polls a deployed base URL's /health until healthy or times out.
 * Usage: tsx src/scripts/smoke.ts <baseUrl>
 * Exits 0 on healthy, 1 otherwise (fails the CD job → triggers rollback, R18.5).
 */
async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? process.env.SMOKE_URL;
  if (!baseUrl) {
    console.error("usage: tsx src/scripts/smoke.ts <baseUrl>");
    process.exit(1);
  }
  const url = `${baseUrl.replace(/\/$/, "")}/health`;
  const deadline = Date.now() + 120_000; // up to 2 minutes for the task to come healthy
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "ok") {
          console.log(`smoke OK: ${url} → ${JSON.stringify(body)}`);
          process.exit(0);
        }
        lastErr = `unexpected body ${JSON.stringify(body)}`;
      } else {
        lastErr = `status ${res.status}`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.error(`smoke FAILED for ${url}: ${lastErr}`);
  process.exit(1);
}

void main();
