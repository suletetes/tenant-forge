import { z } from "zod";

/** Signup request/response contracts (single source of truth → OpenAPI, R14.1). */
export const signupBody = z.object({
  organizationName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type SignupBody = z.infer<typeof signupBody>;

export const signupResponse = z.object({
  organization_id: z.string().uuid(),
  owner_user_id: z.string().uuid(),
  slug: z.string(),
});

export const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof loginBody>;

export const loginResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
});

export const inviteBody = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});
export type InviteBody = z.infer<typeof inviteBody>;

export const acceptInviteBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});
export type AcceptInviteBody = z.infer<typeof acceptInviteBody>;

export const resetRequestBody = z.object({ email: z.string().email() });
export type ResetRequestBody = z.infer<typeof resetRequestBody>;

export const resetConfirmBody = z.object({
  token: z.string().min(1),
  new_password: z.string().min(8).max(200),
});
export type ResetConfirmBody = z.infer<typeof resetConfirmBody>;

export const refreshBody = z.object({ refresh_token: z.string().min(1) });
export type RefreshBody = z.infer<typeof refreshBody>;
