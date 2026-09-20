import type { PoolClient } from "pg";
import { errors } from "../errors";

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
}

interface Actor {
  tenantId: string;
  userId: string;
}

async function audit(db: PoolClient, actor: Actor, action: string, target: string): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, target) VALUES ($1,$2,$3,$4)`,
    [actor.tenantId, actor.userId, action, target],
  );
}

/**
 * All queries run on the request's tenant-scoped connection (req.db). RLS filters by the
 * transaction-local tenant, so no explicit WHERE tenant_id is needed for isolation — but we
 * still stamp tenant_id on INSERT from the token, never the body (R8.2).
 */
export async function createProject(
  db: PoolClient,
  actor: Actor,
  input: { name: string; description?: string | undefined },
): Promise<ProjectRow> {
  const res = await db.query<ProjectRow>(
    `INSERT INTO projects (tenant_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, status, created_at`,
    [actor.tenantId, input.name, input.description ?? null],
  );
  const row = res.rows[0]!;
  await audit(db, actor, "project.created", row.id);
  return row;
}

export async function getProject(db: PoolClient, id: string): Promise<ProjectRow> {
  const res = await db.query<ProjectRow>(
    `SELECT id, name, description, status, created_at FROM projects WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw errors.notFound("Project not found"); // foreign/unknown id both → 404 (R8.6)
  return row;
}

export interface ListResult {
  data: ProjectRow[];
  next_cursor: string | null;
}

/** Cursor pagination over (created_at, id). Cursor is base64url of `${created_at}|${id}`. */
export async function listProjects(
  db: PoolClient,
  opts: { cursor?: string | undefined; limit: number },
): Promise<ListResult> {
  const params: unknown[] = [];
  let where = "";
  if (opts.cursor) {
    let decoded: string;
    try {
      decoded = Buffer.from(opts.cursor, "base64url").toString("utf8");
    } catch {
      throw errors.badRequest("Invalid cursor");
    }
    const sep = decoded.lastIndexOf("|");
    if (sep <= 0) throw errors.badRequest("Invalid cursor");
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    // Guard the shape: `<iso-timestamp>|<uuid>`.
    if (!/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(Date.parse(createdAt))) {
      throw errors.badRequest("Invalid cursor");
    }
    params.push(createdAt, id);
    where = `WHERE (created_at, id) < ($1::timestamptz, $2::uuid)`;
  }
  params.push(opts.limit + 1);
  const res = await db.query<ProjectRow>(
    `SELECT id, name, description, status, created_at FROM projects
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows;
  let next: string | null = null;
  if (rows.length > opts.limit) {
    const last = rows[opts.limit - 1]!;
    next = Buffer.from(`${last.created_at}|${last.id}`, "utf8").toString("base64url");
    rows.length = opts.limit;
  }
  return { data: rows, next_cursor: next };
}

export async function updateProject(
  db: PoolClient,
  actor: Actor,
  id: string,
  patch: {
    name?: string | undefined;
    description?: string | null | undefined;
    status?: string | undefined;
  },
): Promise<ProjectRow> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) return getProject(db, id);
  sets.push(`updated_at = now()`);
  params.push(id);
  const res = await db.query<ProjectRow>(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = $${params.length}
     RETURNING id, name, description, status, created_at`,
    params,
  );
  const row = res.rows[0];
  if (!row) throw errors.notFound("Project not found");
  await audit(db, actor, "project.updated", id);
  return row;
}

export async function deleteProject(db: PoolClient, actor: Actor, id: string): Promise<void> {
  const res = await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
  if (res.rowCount === 0) throw errors.notFound("Project not found");
  await audit(db, actor, "project.deleted", id);
}
