import { z } from "zod";

export const createProjectBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});
export type CreateProjectBody = z.infer<typeof createProjectBody>;

export const updateProjectBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;

export const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListQuery = z.infer<typeof listQuery>;

export const projectParams = z.object({ id: z.string().uuid() });
