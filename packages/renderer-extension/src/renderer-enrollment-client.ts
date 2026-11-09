import {
  ENROLLMENT_LIST_METHOD,
  ENROLLMENT_REVOKE_METHOD,
  enrollmentListResultSchema,
  enrollmentRevokeParamsSchema,
  enrollmentRevokeResultSchema,
  type EnrollmentListResult,
  type EnrollmentRevokeResult,
} from "@codexhost/shared-contracts";

export interface RendererEnrollmentClient {
  listEnrollments(): Promise<EnrollmentListResult>;
  revokeEnrollment(enrollmentId: string): Promise<EnrollmentRevokeResult>;
}

export class RendererEnrollmentUnavailableError extends Error {
  constructor() {
    super("Client enrollment is unavailable");
    this.name = "RendererEnrollmentUnavailableError";
  }
}

/** Fixed, typed methods only; callers never receive an arbitrary request bridge. */
export function createRendererEnrollmentClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): RendererEnrollmentClient {
  const request = async (method: string, params: unknown): Promise<unknown> => {
    try {
      return await send(method, params);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === -32601 || code === -32076) throw new RendererEnrollmentUnavailableError();
      throw error;
    }
  };
  return {
    async listEnrollments() {
      return enrollmentListResultSchema.parse(await request(ENROLLMENT_LIST_METHOD, {}));
    },
    async revokeEnrollment(enrollmentId) {
      const params = enrollmentRevokeParamsSchema.parse({ enrollmentId });
      return enrollmentRevokeResultSchema.parse(await request(ENROLLMENT_REVOKE_METHOD, params));
    },
  };
}
