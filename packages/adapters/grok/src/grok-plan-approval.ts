import {
  validateHostQuestionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostQuestionInteraction,
  type HostQuestionResponse,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  type HostInteractionId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

export const GROK_EXIT_PLAN_MODE_METHODS = ["_x.ai/exit_plan_mode", "x.ai/exit_plan_mode"] as const;

const DECISION_ID = "plan-decision";
const FEEDBACK_ID = "plan-feedback";

export type GrokPlanApprovalOutcome = "approved" | "cancelled" | "abandoned";

export interface GrokPlanApprovalRequest {
  sessionId: string;
  toolCallId: string;
  planContent: string | null;
}

export interface GrokPlanApprovalResponse {
  outcome: GrokPlanApprovalOutcome;
  feedback?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isGrokExitPlanModeMethod(method: string): boolean {
  return (GROK_EXIT_PLAN_MODE_METHODS as readonly string[]).includes(method);
}

/** Native `x.ai/exit_plan_mode` reverse-request. Missing or blank plan text is still approvable. */
export function parseGrokPlanApprovalRequest(value: unknown): GrokPlanApprovalRequest {
  if (!isRecord(value) || !nonEmptyString(value.sessionId) || !nonEmptyString(value.toolCallId)) {
    throw new Error("Grok plan approval requires sessionId and toolCallId");
  }
  const raw = value.planContent ?? value.plan_content;
  if (raw != null && typeof raw !== "string") {
    throw new Error("Grok plan approval planContent must be text");
  }
  return {
    sessionId: value.sessionId,
    toolCallId: value.toolCallId,
    planContent: typeof raw === "string" && raw.trim().length > 0 ? raw : null,
  };
}

export function createGrokPlanReview(
  request: GrokPlanApprovalRequest,
  interactionId: HostQuestionInteraction["interactionId"],
  turnId: HostQuestionInteraction["turnId"],
): HostQuestionInteraction {
  const warning =
    "Approving this plan will exit Grok plan mode and let Grok begin implementation under the current Ask, Auto, or Always approve setting. This is not a one-time tool approval.";
  const prompt = request.planContent
    ? `${warning}\n\n${request.planContent}`
    : `${warning}\n\n# No plan written yet\n\nGrok exited plan mode without a plan body. You can still approve and start implementing, stay in plan mode, or turn plan mode off.`;
  return {
    type: "question",
    interactionId,
    turnId,
    title: "Review plan",
    questions: [
      {
        id: DECISION_ID,
        type: "choice",
        prompt,
        options: [
          {
            value: "cancelled",
            label: "Stay in plan mode",
            description: "Keep planning. Optional comments below are sent as change requests.",
          },
          {
            value: "approved",
            label: "Approve plan and start implementation",
            description: "Exit plan mode and begin implementing.",
          },
          {
            value: "abandoned",
            label: "Exit plan mode without implementing",
            description: "Turn plan mode off and do not start implementation.",
          },
        ],
        multiple: false,
        allowOther: false,
        optional: false,
      },
      {
        id: FEEDBACK_ID,
        type: "text",
        prompt: "Optional changes to request if you stay in plan mode",
        multiline: true,
        secret: false,
        optional: true,
      },
    ],
  };
}

export function grokPlanReviewResponse(response: HostQuestionResponse): GrokPlanApprovalResponse {
  if (response.cancelled) return { outcome: "cancelled" };
  const decision = response.answers[DECISION_ID]?.[0];
  const outcome: GrokPlanApprovalOutcome =
    decision === "approved" || decision === "abandoned" ? decision : "cancelled";
  const feedback = response.answers[FEEDBACK_ID]?.[0]?.trim();
  return {
    outcome,
    ...(outcome === "cancelled" && feedback ? { feedback } : {}),
  };
}

interface PendingPlanApproval {
  request: GrokPlanApprovalRequest;
  interaction: HostQuestionInteraction;
  resolve(response: GrokPlanApprovalResponse): void;
}

/** One Turn's `exit_plan_mode` reverse-requests. Unknown outcomes stay in plan mode. */
export class GrokPlanApprovals {
  readonly #pending = new Map<HostInteractionId, PendingPlanApproval>();
  readonly #seenToolCalls = new Set<string>();
  #closed = false;

  constructor(
    private readonly turnId: HostTurnId,
    private readonly randomUUID: () => string,
    private readonly emit: (output: HarnessOutput) => void,
  ) {}

  has(interactionId: HostInteractionId): boolean {
    return this.#pending.has(interactionId);
  }

  ask(request: GrokPlanApprovalRequest): Promise<GrokPlanApprovalResponse> {
    if (this.#closed || this.#seenToolCalls.has(request.toolCallId))
      return Promise.resolve({ outcome: "cancelled" });
    this.#seenToolCalls.add(request.toolCallId);
    const interaction = createGrokPlanReview(
      request,
      hostInteractionIdSchema.parse(this.randomUUID()),
      this.turnId,
    );
    return new Promise((resolve) => {
      this.#pending.set(interaction.interactionId, { request, interaction, resolve });
      this.emit({ kind: "interaction", interaction });
    });
  }

  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending) return this.#error("invalidState", "Grok plan approval is not pending");
    if (command.response.type !== "question") {
      return this.#error("invalidRequest", "Grok plan approval requires a Question Response");
    }
    const error = validateHostQuestionResponse(pending.interaction, command.response);
    if (error) return { ok: false, error };
    this.#settle(
      pending,
      grokPlanReviewResponse(command.response),
      command.response.cancelled ? "cancelled" : "responded",
    );
    return { ok: true, value: { accepted: true } };
  }

  withdraw(toolCallId: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.request.toolCallId === toolCallId)
        this.#settle(pending, { outcome: "cancelled" }, "cancelled");
    }
  }

  cancel(): void {
    this.#closed = true;
    for (const pending of this.#pending.values())
      this.#settle(pending, { outcome: "cancelled" }, "cancelled");
  }

  #settle(
    pending: PendingPlanApproval,
    response: GrokPlanApprovalResponse,
    reason: "responded" | "cancelled",
  ): void {
    if (!this.#pending.delete(pending.interaction.interactionId)) return;
    pending.resolve(response);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: this.turnId,
        reason,
      },
    });
  }

  #error(code: "invalidRequest" | "invalidState", message: string): HarnessResult<never> {
    return { ok: false, error: { code, message, retryable: false } };
  }
}
