import {
  validateHostQuestionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostQuestionInteraction,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  questionAutoResolutionSchema,
  type HostInteractionId,
  type HostTurnId,
  type QuestionAutoResolution,
} from "@codexhost/shared-contracts";

export const GROK_ASK_USER_QUESTION_METHOD = "_x.ai/ask_user_question";
export const GROK_QUESTION_ACTIVITY_METHOD = "_x.ai/ask_user_question_activity";

interface GrokQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface GrokQuestionRequest {
  sessionId: string;
  toolCallId: string;
  mode: "default" | "plan";
  questions: Array<{ question: string; options: GrokQuestionOption[]; multiple?: boolean }>;
  timeout?: QuestionAutoResolution;
}

export type GrokQuestionResponse =
  | { outcome: "cancelled" }
  | {
      outcome: "accepted";
      answers: Record<string, string[]>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Native Question ids are optional; answers are keyed by the unique question text. */
export function parseGrokQuestionRequest(value: unknown): GrokQuestionRequest {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.sessionId) ||
    !nonEmptyString(value.toolCallId) ||
    (value.mode !== "default" && value.mode !== "plan") ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0
  ) {
    throw new Error("Grok question requires sessionId, toolCallId, mode and nonempty questions");
  }
  const seen = new Set<string>();
  const questions = value.questions.map((question) => {
    if (
      !isRecord(question) ||
      !nonEmptyString(question.question) ||
      seen.has(question.question) ||
      !Array.isArray(question.options) ||
      (question.multiSelect != null && typeof question.multiSelect !== "boolean") ||
      (question.multi_select != null && typeof question.multi_select !== "boolean")
    ) {
      throw new Error("Grok question text must be unique and options/multiSelect must be valid");
    }
    if (
      question.multiSelect != null &&
      question.multi_select != null &&
      question.multiSelect !== question.multi_select
    )
      throw new Error("Grok question contains conflicting multi-select flags");
    seen.add(question.question);
    const labels = new Set<string>();
    const options = question.options.map((option) => {
      if (
        !isRecord(option) ||
        !nonEmptyString(option.label) ||
        labels.has(option.label) ||
        typeof option.description !== "string" ||
        (option.preview != null && typeof option.preview !== "string")
      ) {
        throw new Error(
          "Grok question options require unique labels and text descriptions/previews",
        );
      }
      labels.add(option.label);
      return {
        label: option.label,
        description: option.description,
        ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
      };
    });
    return {
      question: question.question,
      options,
      multiple: question.multiSelect === true || question.multi_select === true,
    };
  });
  const timeout =
    value.timeout == null ? undefined : questionAutoResolutionSchema.parse(value.timeout);
  return {
    sessionId: value.sessionId,
    toolCallId: value.toolCallId,
    mode: value.mode,
    questions,
    ...(timeout ? { timeout } : {}),
  };
}

interface PendingQuestion {
  request: GrokQuestionRequest;
  interaction: HostQuestionInteraction;
  resolve(response: GrokQuestionResponse): void;
}

/** One Turn's reverse-requests; native interaction_resolved owns timeout withdrawal. */
export class GrokQuestions {
  readonly #pending = new Map<HostInteractionId, PendingQuestion>();
  readonly #seenToolCalls = new Set<string>();

  constructor(
    private readonly turnId: HostTurnId,
    private readonly randomUUID: () => string,
    private readonly emit: (output: HarnessOutput) => void,
  ) {}

  has(interactionId: HostInteractionId): boolean {
    return this.#pending.has(interactionId);
  }

  async activity(
    interactionId: HostInteractionId,
    reset: (toolCallId: string) => Promise<QuestionAutoResolution | null>,
  ): Promise<QuestionAutoResolution | null> {
    const pending = this.#pending.get(interactionId);
    if (!pending?.interaction.autoResolution?.resetOnActivity) return null;
    const timeout = await reset(pending.request.toolCallId);
    if (this.#pending.get(interactionId) !== pending) return null;
    return timeout;
  }

  ask(request: GrokQuestionRequest): Promise<GrokQuestionResponse> {
    if (this.#seenToolCalls.has(request.toolCallId))
      return Promise.resolve({ outcome: "cancelled" });
    this.#seenToolCalls.add(request.toolCallId);
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(this.randomUUID()),
      turnId: this.turnId,
      title: "Grok",
      ...(request.timeout ? { autoResolution: request.timeout } : {}),
      questions: request.questions.map((question, index) =>
        question.options.length
          ? {
              id: `q${index}`,
              type: "choice",
              prompt: question.question,
              options: question.options.map(({ label, description, preview }) => ({
                value: label,
                label,
                description: [description, preview].filter(Boolean).join("\n\n"),
              })),
              multiple: question.multiple ?? false,
              allowOther: true,
              optional: true,
            }
          : {
              id: `q${index}`,
              type: "text",
              prompt: question.question,
              multiline: true,
              secret: false,
              optional: true,
            },
      ),
    };
    return new Promise((resolve) => {
      this.#pending.set(interaction.interactionId, { request, interaction, resolve });
      this.emit({ kind: "interaction", interaction });
    });
  }

  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending) return this.#error("invalidState", "Grok Question is not pending");
    if (command.response.type !== "question") {
      return this.#error("invalidRequest", "Grok Question requires a Question Response");
    }
    const response = command.response;
    const error = validateHostQuestionResponse(pending.interaction, response);
    if (error) return { ok: false, error };
    if (response.cancelled) {
      this.#settle(pending, { outcome: "cancelled" }, "cancelled");
      return { ok: true, value: { accepted: true } };
    }
    const answers = new Map<string, string[]>();
    const annotations = new Map<string, { preview?: string; notes?: string }>();
    for (const [index, question] of pending.request.questions.entries()) {
      const values = response.answers[`q${index}`];
      if (!values?.length) continue;
      if (values.some((answer) => !nonEmptyString(answer)))
        return this.#error("invalidRequest", "Grok answer must not be empty");
      const selected = values.map((answer) =>
        question.options.find(({ label }) => label === answer),
      );
      const other = values.filter((_, position) => !selected[position]);
      if (other.length > 1)
        return this.#error("invalidRequest", "Grok question accepts only one Other response");
      answers.set(
        question.question,
        selected.map((option) => option?.label ?? "Other"),
      );
      const previews = selected.flatMap((option) =>
        option?.preview !== undefined ? [option.preview] : [],
      );
      if (previews.length || other.length)
        annotations.set(question.question, {
          ...(previews.length ? { preview: previews.join("\n\n") } : {}),
          ...(other.length ? { notes: other[0] } : {}),
        });
    }
    this.#settle(
      pending,
      {
        outcome: "accepted",
        answers: Object.fromEntries(answers),
        ...(annotations.size ? { annotations: Object.fromEntries(annotations) } : {}),
      },
      "responded",
    );
    return { ok: true, value: { accepted: true } };
  }

  withdraw(toolCallId: string): void {
    // Permission resolution can precede a question with the same tool-call id.
    // Only withdraw a question that has actually opened.
    for (const pending of this.#pending.values()) {
      if (pending.request.toolCallId === toolCallId)
        this.#settle(pending, { outcome: "cancelled" }, "cancelled");
    }
  }

  cancel(): void {
    for (const pending of this.#pending.values())
      this.#settle(pending, { outcome: "cancelled" }, "cancelled");
  }

  #settle(
    pending: PendingQuestion,
    response: GrokQuestionResponse,
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
