# TenantForge Admin SPA (optional demo client)

A thin, single-file React SPA (`index.html`) that demonstrates the TenantForge flow: signup →
login → projects CRUD, with the live `X-RateLimit-*` headers displayed. No bundler — React and
Babel load from a CDN, so it's a static asset you can open directly or host on S3 + CloudFront.

## Run locally

Start the API (with Redis so rate-limit headers appear), then serve this folder:

```bash
# API (separate terminal): npm run dev   (set REDIS_URL to see RateLimit headers)
# Serve the SPA:
npx serve web        # or: python -m http.server 8080 --directory web
# open http://localhost:3000 (serve) / http://localhost:8080 and set the API base URL
```

Point the SPA at the API via the **API base URL** field, the `?api=` query param
(`?api=http://localhost:3000`), or `localStorage`. The API must allow the SPA origin via
`CORS_ORIGIN` (defaults to `*` for the demo; set a specific origin in production).

Click **Refresh** rapidly to watch `X-RateLimit-Remaining` fall and eventually see a `429`.

## Deploy

The `infra/modules/static-site` Terraform module provisions a private S3 bucket + CloudFront
(Origin Access Control, TLS, SPA fallback to `index.html`). Enable it per environment with
`enable_admin_spa = true` in the stack, then upload:

```bash
aws s3 cp web/index.html "s3://$(terraform output -raw admin_spa_bucket)/index.html"
```

> Optional (spec Task 22). The API and its guarantees are the product; this is a visual demo.
