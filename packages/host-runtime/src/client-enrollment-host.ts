import {
  ENROLLMENT_LIST_METHOD,
  ENROLLMENT_REVOKE_METHOD,
  enrollmentListParamsSchema,
  enrollmentListResultSchema,
  enrollmentRevokeParamsSchema,
  enrollmentRevokeResultSchema,
} from "@codexhost/shared-contracts";

import type { EnrollmentAuthority } from "./client-enrollment-authority.js";

export function isEnrollmentHostMethod(method: string): boolean {
  return method === ENROLLMENT_LIST_METHOD || method === ENROLLMENT_REVOKE_METHOD;
}

export async function handleEnrollmentHostRequest(input: {
  enrollment: EnrollmentAuthority | undefined;
  method: string;
  params: unknown;
}): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
  if (!input.enrollment) {
    return { error: { code: -32000, message: "Enrollment is unavailable on this Host" } };
  }
  if (input.method === ENROLLMENT_LIST_METHOD) {
    const parsed = enrollmentListParamsSchema.safeParse(input.params ?? {});
    if (!parsed.success) {
      return { error: { code: -32602, message: "Invalid enrollment list request" } };
    }
    return {
      result: enrollmentListResultSchema.parse({ enrollments: input.enrollment.listPublic() }),
    };
  }
  const parsed = enrollmentRevokeParamsSchema.safeParse(input.params ?? {});
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid enrollment revoke request" } };
  }
  try {
    return {
      result: enrollmentRevokeResultSchema.parse(
        await input.enrollment.revokeEnrollment(parsed.data.enrollmentId),
      ),
    };
  } catch (error) {
    return {
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Enrollment is not active",
      },
    };
  }
}
