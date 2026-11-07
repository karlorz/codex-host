export interface EnrollmentConsentRequest {
  clientId: string;
  executablePath: string;
  allowlist: { threadId: string; verbs: readonly string[] }[];
}

export type EnrollmentConsentDecision = "approve" | "deny" | "timeout";

/**
 * Attended Desktop Approve/Deny for enrollment. Production Host uses a timeout
 * that fails closed when no Desktop prompt can run unattended; tests inject
 * Approve/Deny stubs.
 */
export interface EnrollmentConsent {
  decide(request: EnrollmentConsentRequest): Promise<EnrollmentConsentDecision>;
}

export function createStubEnrollmentConsent(
  decision:
    | EnrollmentConsentDecision
    | (() => EnrollmentConsentDecision | Promise<EnrollmentConsentDecision>),
): EnrollmentConsent {
  return {
    async decide() {
      return typeof decision === "function" ? await decision() : decision;
    },
  };
}

/** Fail-closed attended prompt: no unattended Desktop UI, so the request times out. */
export function createTimeoutEnrollmentConsent(input: { timeoutMs: number }): EnrollmentConsent {
  return {
    async decide() {
      if (input.timeoutMs <= 0) return "timeout";
      await new Promise<void>((resolve) => {
        setTimeout(resolve, input.timeoutMs);
      });
      return "timeout";
    },
  };
}

export const DEFAULT_ENROLLMENT_CONSENT_TIMEOUT_MS = 60_000;
