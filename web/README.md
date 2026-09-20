# TenantForge Admin SPA

A minimal single-file React SPA (`index.html`) that provides a visual demo of the TenantForge API. It covers the full user-facing flow: organization signup, login, project CRUD, and live rate-limit header display. No bundler is required — React and Babel load from CDN, so the file runs as a plain static asset.

This is an optional component (spec Task 22). The API and its guarantees are the product; this is a visual demonstration aid for portfolio and hiring conversations.

---

## What It Shows

- **Signup and login** — creates an organization + owner, exchanges credentials for a JWT.
- **Project CRUD** — create, list, view, and delete projects using the authenticated tenant session.
- **Rate limit display** — the `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` response headers are displayed live. Click Refresh rapidly to watch the counter drain and trigger a `429 Too Many Requests` with `Retry-After`.

---

## Running Locally

Start the API in a separate terminal (Redis must be running for rate-limit headers to appear):

```bash
# Terminal 1: dependencies
docker run -d -p 6379:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6379
npm run dev

# Terminal 2: serve the SPA
npx serve web
# Open http://localhost:3000 (or whatever port serve reports)
```

Configure the API base URL one of three ways:

1. Enter it in the **API base URL** input field in the SPA.
2. Pass it as a query parameter: `http://localhost:3000?api=http://localhost:3000`.
3. Set it in `localStorage`: `localStorage.setItem('api', 'http://localhost:3000')`.

The API must allow the SPA's origin. The default `CORS_ORIGIN=*` works for local development. Set a specific origin in any deployed environment.

---

## Deploying to S3 + CloudFront

The `infra/modules/static-site` Terraform module provisions:

- A private S3 bucket (no public access, versioning enabled).
- A CloudFront distribution with Origin Access Control.
- An HTTPS certificate via ACM.
- A fallback rule so all paths serve `index.html` (SPA routing).

Enable it per environment in the stack configuration:

```hcl
# infra/envs/dev/main.tf
module "stack" {
  source           = "../../modules/stack"
  enable_admin_spa = true
  # ... other vars
}
```

After `terraform apply`, upload the file:

```bash
BUCKET=$(terraform -chdir=infra/envs/dev output -raw admin_spa_bucket)
aws s3 cp web/index.html "s3://${BUCKET}/index.html" \
  --cache-control "no-cache, no-store, must-revalidate"
```

The CloudFront domain is available as:

```bash
terraform -chdir=infra/envs/dev output admin_spa_domain
```

---

## Environment Variables

The SPA itself has no build step and no secrets. It reads the API base URL from user input or `localStorage` at runtime. All sensitive values (JWT signing secret, Stripe keys, database credentials) live in AWS Secrets Manager and are injected into the ECS container at startup — they never reach the browser.
