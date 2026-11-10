export interface EnrollmentConsentRequest {
  clientId: string;
  executablePath: string;
  allowlist: { threadId: string; verbs: readonly string[] }[];
}

export type EnrollmentConsentDecision = "approve" | "deny" | "timeout" | "unavailable";

/**
 * Attended Desktop Approve/Deny for enrollment. Production Host has no prompt
 * and fails closed immediately; tests inject Approve/Deny/timeout stubs.
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

/** Production Desktop has no enrollment prompt; fail immediately instead of waiting. */
export function createUnavailableEnrollmentConsent(): EnrollmentConsent {
  return {
    async decide() {
      return "unavailable";
    },
  };
}
