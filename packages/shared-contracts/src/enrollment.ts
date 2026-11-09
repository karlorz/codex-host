import { z } from "zod";

/** Host settings and console: list active enrollments without tokens. */
export const ENROLLMENT_LIST_METHOD = "codexhost/enrollment/list";
/** Host settings and console: revoke one enrollment by id. */
export const ENROLLMENT_REVOKE_METHOD = "codexhost/enrollment/revoke";

export const enrollmentAllowlistEntrySchema = z.strictObject({
  threadId: z.string().trim().min(1).max(128),
  verbs: z
    .array(z.enum(["read", "watch", "send"]))
    .min(1)
    .max(3),
});

/** Public enrollment fields. Never includes a token. */
export const enrollmentPublicViewSchema = z.strictObject({
  enrollmentId: z.string().trim().min(1).max(128),
  threadId: z.string().trim().min(1).max(128),
  clientId: z.string().trim().min(1).max(64),
  executablePath: z.string().min(1).max(4096),
  endpoint: z.string().min(1).max(2048),
  issuedAt: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
  pairing: z.enum(["session", "machine"]),
  allowlist: z.array(enrollmentAllowlistEntrySchema).max(64),
});

export const enrollmentListParamsSchema = z.strictObject({});

export const enrollmentListResultSchema = z.strictObject({
  enrollments: z.array(enrollmentPublicViewSchema).max(256),
});

export const enrollmentRevokeParamsSchema = z.strictObject({
  enrollmentId: z.string().trim().min(1).max(128),
});

export const enrollmentRevokeResultSchema = z.strictObject({
  enrollmentId: z.string().trim().min(1).max(128),
  revoked: z.literal(true),
});

export type EnrollmentPublicView = z.infer<typeof enrollmentPublicViewSchema>;
export type EnrollmentListResult = z.infer<typeof enrollmentListResultSchema>;
export type EnrollmentRevokeResult = z.infer<typeof enrollmentRevokeResultSchema>;
