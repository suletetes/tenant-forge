# Deployment & Rollback Runbook

Covers the CD pipeline (`.github/workflows/cd.yml`) — how a deploy proceeds and how to roll back.
Satisfies R18 (CI/CD with migrations + environment promotion) and the R18.5 rollback path.

## Pipeline order (per environment)

1. **Terraform apply** — provisions/updates infra (VPC, RDS, ALB, ECS, IAM, Secrets). The ECS
   task definition is updated to the new image (`app_image = <ecr>:<git-sha>`).
2. **Pre-migration safeguards** — before any schema change:
   - Create an RDS snapshot (`premigrate-<sha>-<ts>`) and wait for it to be available.
   - Record the currently-running ECS task definition ARN (`PREV_TASK_DEF`).
3. **DB migrations** — `npm run db:migrate` runs `src/db/migrate.ts` as the **migrator role**
   (`MIGRATION_DATABASE_URL`), never the app role. Applies Drizzle table DDL, then re-asserts
   roles + RLS policies (idempotent).
4. **ECS deploy** — `aws ecs update-service --force-new-deployment`; wait for `services-stable`.
5. **Smoke test** — `npm run smoke -- http://<alb-dns>` polls `/health` until healthy (2 min cap).
6. **Rollback on smoke failure** — restore `PREV_TASK_DEF` and force a new deployment; the job
   fails and surfaces the DB snapshot id for manual restore if needed.
7. **Staging → Prod gate** — `deploy-prod` runs only after `deploy-staging` succeeds and requires
   manual approval via the GitHub `production` environment protection rule (R18.4).

## Rollback scenarios

### App-only regression (schema unchanged)
The automatic rollback in step 6 handles this: the ECS service returns to `PREV_TASK_DEF`
(previous image) and stabilizes. No DB action needed.

### Migration caused data/schema issues
Migrations are forward-only. To roll back schema/data:
1. Roll the app back to `PREV_TASK_DEF` first (as above) so no traffic hits the new schema.
2. Restore the pre-migration snapshot to a new instance:
   ```
   aws rds restore-db-instance-from-db-snapshot \
     --db-instance-identifier tenantforge-<env>-pg-restore \
     --db-snapshot-identifier <premigrate-snapshot-id>
   ```
3. Repoint the app (Secrets Manager `DATABASE_URL`/`MIGRATION_DATABASE_URL`) at the restored
   instance, or swap endpoints, then redeploy.
4. Author a corrective forward migration; never hand-edit production schema.

### Full stack teardown (cost control, NFR3.2)
Between demos: `terraform destroy` in the env dir. Keep repo, diagrams, committed `openapi.json`,
and the recorded demo. The RDS snapshot persists independently for later restore.

## Required GitHub configuration

- **Secrets:** `AWS_CD_ROLE_ARN`, `AWS_CI_ROLE_ARN`, `AWS_ACCOUNT_ID`, `JWT_SIGNING_SECRET`,
  `DB_MASTER_PASSWORD`, `APP_DB_PASSWORD`, `STAGING_MIGRATION_DATABASE_URL`,
  `PROD_MIGRATION_DATABASE_URL`.
- **Variables:** `AWS_REGION`, `TF_STATE_BUCKET`, `TF_LOCK_TABLE`.
- **Environments:** `staging` (auto), `production` (protected — require reviewers).

> IaC and pipelines are validated as code but NOT yet applied to AWS. Applying requires the
> account owner's credentials and explicit go-ahead (running the bootstrap stack first).
