import { describe, expect, it, vi } from "vitest";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type {
  HarnessOutput,
  HostInteractionResponse,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";
import { GrokQuestions } from "../src/grok-questions.js";
import { parseGrokQuestionRequest } from "../src/index.js";

const request = {
  sessionId: "native-session",
  toolCallId: "ask-1",
  mode: "default",
  questions: [
    {
      id: "opaque-native-id",
      question: "Which letter?",
      multiSelect: false,
      options: [
        { id: "opaque-option", label: "Alpha", description: "First", preview: "Alpha preview" },
        { label: "Beta", description: "Second" },
      ],
    },
  ],
};

function setup() {
  const outputs: HarnessOutput[] = [];
  let id = 0;
  const questions = new GrokQuestions(
    hostTurnIdSchema.parse("turn-1"),
    () => `ask-${++id}`,
    (output) => outputs.push(output),
  );
  const interaction = (): HostQuestionInteraction => {
    const output = outputs.findLast((output) => output.kind === "interaction");
    if (!output || output.kind !== "interaction" || output.interaction.type !== "question")
      throw new Error("Missing Question");
    return output.interaction;
  };
  return { questions, outputs, interaction };
}

describe("Grok native questions", () => {
  it("maps activity to the pending native tool and ignores acknowledgements after withdrawal", async () => {
    const { questions, interaction, outputs } = setup();
    const timeout = {
      deadlineUnixMs: Date.now() + 1000,
      action: "recommended",
      resetOnActivity: true,
    };
    const pending = questions.ask(parseGrokQuestionRequest({ ...request, timeout }));
    const initial = interaction().autoResolution;
    if (!initial) throw new Error("Missing native timeout");
    const ack = { ...initial, deadlineUnixMs: Date.now() + 120000 };
    const reset = vi.fn(async () => ack);
    expect(await questions.activity(interaction().interactionId, reset)).toEqual(ack);
    expect(reset).toHaveBeenCalledWith(request.toolCallId);
    expect(outputs).toHaveLength(1);
    let complete!: (value: typeof ack) => void;
    const late = questions.activity(
      interaction().interactionId,
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    questions.withdraw(request.toolCallId);
    complete(ack);
    expect(await late).toBeNull();
    expect(await questions.activity(interaction().interactionId, reset)).toBeNull();
    expect(reset).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
  });
  it.each([undefined, false])(
    "does not ping when activity reset is %s",
    async (resetOnActivity) => {
      const { questions, interaction } = setup();
      const pending = questions.ask(
        parseGrokQuestionRequest({
          ...request,
          timeout: {
            deadlineUnixMs: 1,
            action: "decline",
            ...(resetOnActivity === undefined ? {} : { resetOnActivity }),
          },
        }),
      );
      const reset = vi.fn();
      expect(await questions.activity(interaction().interactionId, reset)).toBeNull();
      expect(reset).not.toHaveBeenCalled();
      questions.cancel();
      await pending;
    },
  );
  it("preserves optional native countdown metadata without a Host expiry", async () => {
    const { questions, interaction } = setup();
    const timeout = { deadlineUnixMs: Date.now() - 1000, action: "recommended" };
    const pending = questions.ask(parseGrokQuestionRequest({ ...request, timeout }));
    expect(interaction().autoResolution).toEqual(timeout);
    expect(interaction().expiresAt).toBeUndefined();
    expect(questions.has(interaction().interactionId)).toBe(true);
    questions.withdraw(request.toolCallId);
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
  });

  it.each([
    { deadlineUnixMs: -1, action: "recommended" },
    { deadlineUnixMs: Infinity, action: "recommended" },
    { deadlineUnixMs: 8_640_000_000_000_001, action: "recommended" },
    { deadlineUnixMs: 10, action: "unknown" },
  ])("rejects invalid native countdown metadata: %j", (timeout) => {
    expect(() => parseGrokQuestionRequest({ ...request, timeout })).toThrow();
  });

  it("returns ordered question-text keys and selected labels, including preview annotations", async () => {
    const { questions, interaction, outputs } = setup();
    const pending = questions.ask(parseGrokQuestionRequest({ ...request, mode: "plan" }));
    expect(interaction()).toMatchObject({
      title: "Grok",
      questions: [
        {
          type: "choice",
          multiple: false,
          allowOther: true,
          options: [{ value: "Alpha", description: "First\n\nAlpha preview" }, { value: "Beta" }],
        },
      ],
    });
    expect(interaction().expiresAt).toBeUndefined();
    const command = {
      type: "interaction.respond" as const,
      interactionId: interaction().interactionId,
      response: { type: "question" as const, answers: { q0: ["Alpha"] } },
    };
    expect(questions.respond(command)).toEqual({ ok: true, value: { accepted: true } });
    await expect(pending).resolves.toEqual({
      outcome: "accepted",
      answers: { "Which letter?": ["Alpha"] },
      annotations: { "Which letter?": { preview: "Alpha preview" } },
    });
    expect(questions.respond(command)).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(outputs.filter((output) => output.kind === "event")).toHaveLength(1);
    await expect(questions.ask(parseGrokQuestionRequest(request))).resolves.toEqual({
      outcome: "cancelled",
    });
  });

  it("maps Other text and optionless questions to native notes without joining labels", async () => {
    const { questions, interaction } = setup();
    const pending = questions.ask(
      parseGrokQuestionRequest({
        ...request,
        questions: [request.questions[0], { question: "Any notes?", options: [] }],
      }),
    );
    const command = {
      type: "interaction.respond" as const,
      interactionId: interaction().interactionId,
      response: {
        type: "question" as const,
        answers: { q0: ["Gamma, Delta"], q1: ["Keep both."] },
      },
    };
    expect(questions.respond(command)).toMatchObject({ ok: true });
    await expect(pending).resolves.toEqual({
      outcome: "accepted",
      answers: { "Which letter?": ["Other"], "Any notes?": ["Other"] },
      annotations: {
        "Which letter?": { notes: "Gamma, Delta" },
        "Any notes?": { notes: "Keep both." },
      },
    });
  });

  it("omits unanswered questions from the native accepted result", async () => {
    const { questions, interaction } = setup();
    const pending = questions.ask(
      parseGrokQuestionRequest({
        ...request,
        questions: [request.questions[0], { question: "Any notes?", options: [] }],
      }),
    );
    expect(interaction().questions.every((question) => question.optional)).toBe(true);
    expect(
      questions.respond({
        type: "interaction.respond",
        interactionId: interaction().interactionId,
        response: { type: "question", answers: { q0: ["Beta"] } },
      }),
    ).toMatchObject({ ok: true });
    await expect(pending).resolves.toEqual({
      outcome: "accepted",
      answers: { "Which letter?": ["Beta"] },
    });
  });

  it("does not treat special object keys as prototypes", async () => {
    const { questions, interaction } = setup();
    const pending = questions.ask(
      parseGrokQuestionRequest({ ...request, questions: [{ question: "__proto__", options: [] }] }),
    );
    questions.respond({
      type: "interaction.respond",
      interactionId: interaction().interactionId,
      response: { type: "question", answers: { q0: ["Literal text"] } },
    });
    const response = await pending;
    expect(response.outcome).toBe("accepted");
    if (response.outcome !== "accepted") throw new Error("Expected answer");
    expect(Object.hasOwn(response.answers, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(response))).toMatchObject({
      answers: JSON.parse('{"__proto__":["Other"]}'),
    });
  });

  it.each([
    { type: "approval", actionId: "allow-once" },
    { type: "question", answers: { q0: ["Alpha", "Beta"] } },
    { type: "question", answers: { q0: ["  "] } },
    { type: "question", answers: { unknown: ["Alpha"] } },
    { type: "question", answers: { q0: ["Alpha"] }, cancelled: true },
  ] satisfies HostInteractionResponse[])(
    "rejects an invalid answer without consuming the request: %j",
    async (response) => {
      const { questions, interaction } = setup();
      const pending = questions.ask(parseGrokQuestionRequest(request));
      expect(
        questions.respond({
          type: "interaction.respond",
          interactionId: interaction().interactionId,
          response: structuredClone(response),
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(questions.has(interaction().interactionId)).toBe(true);
      questions.cancel();
      await expect(pending).resolves.toEqual({ outcome: "cancelled" });
    },
  );

  it("withdraws only matching requests and rejects late answers without affecting the next question", async () => {
    const { questions, interaction, outputs } = setup();
    const pending = questions.ask(parseGrokQuestionRequest(request));
    const first = interaction().interactionId;
    questions.withdraw("foreign");
    expect(questions.has(first)).toBe(true);
    questions.withdraw(request.toolCallId);
    questions.withdraw(request.toolCallId);
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
    const next = questions.ask(parseGrokQuestionRequest({ ...request, toolCallId: "ask-2" }));
    expect(
      questions.respond({
        type: "interaction.respond",
        interactionId: first,
        response: { type: "question", answers: { q0: ["Alpha"] } },
      }),
    ).toMatchObject({ ok: false });
    expect(questions.has(interaction().interactionId)).toBe(true);
    questions.cancel();
    questions.cancel();
    await expect(next).resolves.toEqual({ outcome: "cancelled" });
    expect(outputs.filter((output) => output.kind === "event")).toHaveLength(2);
    expect(
      questions.respond({
        type: "interaction.respond",
        interactionId: hostInteractionIdSchema.parse("unknown"),
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).toMatchObject({ ok: false });
  });

  it("does not mistake an earlier permission resolution for withdrawal of a later question", async () => {
    const { questions, outputs, interaction } = setup();
    questions.withdraw(request.toolCallId);
    const pending = questions.ask(parseGrokQuestionRequest(request));
    expect(outputs[0]).toMatchObject({ kind: "interaction", interaction: { type: "question" } });
    questions.respond({
      type: "interaction.respond",
      interactionId: interaction().interactionId,
      response: { type: "question", answers: { q0: ["Beta"] } },
    });
    await expect(pending).resolves.toEqual({
      outcome: "accepted",
      answers: { "Which letter?": ["Beta"] },
    });
  });

  it("maps explicit dismissal to native cancellation", async () => {
    const { questions, interaction } = setup();
    const pending = questions.ask(parseGrokQuestionRequest(request));
    expect(
      questions.respond({
        type: "interaction.respond",
        interactionId: interaction().interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).toMatchObject({ ok: true });
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
  });

  it.each(["multiSelect", "multi_select"])(
    "preserves %s and all selected labels and Other notes",
    async (key) => {
      const { questions, interaction } = setup();
      const native = { ...request.questions[0], multiSelect: undefined };
      const pending = questions.ask(
        parseGrokQuestionRequest({ ...request, questions: [{ ...native, [key]: true }] }),
      );
      expect(interaction().questions[0]).toMatchObject({ multiple: true });
      expect(
        questions.respond({
          type: "interaction.respond",
          interactionId: interaction().interactionId,
          response: { type: "question", answers: { q0: ["Alpha", "Beta", "Custom"] } },
        }),
      ).toMatchObject({ ok: true });
      await expect(pending).resolves.toEqual({
        outcome: "accepted",
        answers: { "Which letter?": ["Alpha", "Beta", "Other"] },
        annotations: { "Which letter?": { preview: "Alpha preview", notes: "Custom" } },
      });
    },
  );

  it("rejects conflicting native flags", () => {
    expect(() =>
      parseGrokQuestionRequest({
        ...request,
        questions: [
          {
            ...request.questions[0],
            multi_select: true,
          },
        ],
      }),
    ).toThrow("conflicting");
  });

  it("rejects duplicate selections without settling the question", async () => {
    const { questions, interaction } = setup();
    const pending = questions.ask(
      parseGrokQuestionRequest({
        ...request,
        questions: [
          {
            ...request.questions[0],
            multiSelect: true,
          },
        ],
      }),
    );
    expect(
      questions.respond({
        type: "interaction.respond",
        interactionId: interaction().interactionId,
        response: { type: "question", answers: { q0: ["Alpha", "Alpha"] } },
      }),
    ).toMatchObject({ ok: false });
    questions.cancel();
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
  });

  it.each([
    {},
    { ...request, mode: "unknown" },
    { ...request, questions: [] },
    { ...request, questions: [request.questions[0], request.questions[0]] },
    { ...request, questions: [{ question: "Q", options: [{ label: "A" }] }] },
    {
      ...request,
      questions: [
        {
          question: "Q",
          options: [
            { label: "A", description: "" },
            { label: "A", description: "" },
          ],
        },
      ],
    },
  ])("rejects malformed native requests: %j", (value) => {
    expect(() => parseGrokQuestionRequest(value)).toThrow();
  });
});
