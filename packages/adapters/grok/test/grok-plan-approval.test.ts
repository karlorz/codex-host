import { describe, expect, it } from "vitest";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput, HostQuestionInteraction } from "@codexhost/harness-adapter";

import {
  GrokPlanApprovals,
  createGrokPlanReview,
  grokPlanReviewResponse,
  isGrokExitPlanModeMethod,
  parseGrokPlanApprovalRequest,
} from "../src/grok-plan-approval.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const interactionId = hostInteractionIdSchema.parse("review-1");

describe("Grok plan approval mapping", () => {
  it("accepts both ACP extension method names", () => {
    expect(isGrokExitPlanModeMethod("_x.ai/exit_plan_mode")).toBe(true);
    expect(isGrokExitPlanModeMethod("x.ai/exit_plan_mode")).toBe(true);
    expect(isGrokExitPlanModeMethod("_x.ai/ask_user_question")).toBe(false);
  });

  it("parses camelCase and snake_case plan bodies, including an empty plan", () => {
    expect(
      parseGrokPlanApprovalRequest({
        sessionId: "sess",
        toolCallId: "tc-1",
        planContent: "# Plan",
      }),
    ).toEqual({ sessionId: "sess", toolCallId: "tc-1", planContent: "# Plan" });
    expect(
      parseGrokPlanApprovalRequest({
        sessionId: "sess",
        toolCallId: "tc-1",
        plan_content: "   ",
      }),
    ).toEqual({ sessionId: "sess", toolCallId: "tc-1", planContent: null });
    expect(() => parseGrokPlanApprovalRequest({ sessionId: "sess" })).toThrow(
      "Grok plan approval requires sessionId and toolCallId",
    );
  });

  it("keeps approve available when Grok did not write a plan", () => {
    const interaction = createGrokPlanReview(
      { sessionId: "sess", toolCallId: "tc", planContent: null },
      interactionId,
      turnId,
    );
    expect(interaction.title).toBe("Review plan");
    const decision = interaction.questions[0];
    if (decision?.type !== "choice") throw new Error("Missing decision");
    expect(decision.prompt).toContain("No plan written yet");
    expect(decision.options.map(({ value }) => value)).toEqual([
      "cancelled",
      "approved",
      "abandoned",
    ]);
  });

  it("maps stay/approve/abandon and only keeps feedback on stay", () => {
    expect(grokPlanReviewResponse({ type: "question", cancelled: true, answers: {} })).toEqual({
      outcome: "cancelled",
    });
    expect(
      grokPlanReviewResponse({
        type: "question",
        answers: { "plan-decision": ["approved"], "plan-feedback": ["ignore me"] },
      }),
    ).toEqual({ outcome: "approved" });
    expect(
      grokPlanReviewResponse({
        type: "question",
        answers: { "plan-decision": ["abandoned"] },
      }),
    ).toEqual({ outcome: "abandoned" });
    expect(
      grokPlanReviewResponse({
        type: "question",
        answers: {
          "plan-decision": ["cancelled"],
          "plan-feedback": ["Please add error handling"],
        },
      }),
    ).toEqual({ outcome: "cancelled", feedback: "Please add error handling" });
  });

  it("settles one review per native tool-call and rejects stale answers", async () => {
    const outputs: HarnessOutput[] = [];
    const approvals = new GrokPlanApprovals(
      turnId,
      () => "review-1",
      (output) => outputs.push(output),
    );
    const request = { sessionId: "sess", toolCallId: "exit-1", planContent: "# Plan" };
    const pending = approvals.ask(request);
    const interaction = outputs.find(
      (output): output is Extract<HarnessOutput, { kind: "interaction" }> =>
        output.kind === "interaction",
    )?.interaction as HostQuestionInteraction;
    expect(
      approvals.respond({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { "plan-decision": ["approved"] } },
      }),
    ).toEqual({ ok: true, value: { accepted: true } });
    await expect(pending).resolves.toEqual({ outcome: "approved" });
    expect(
      approvals.respond({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { "plan-decision": ["approved"] } },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(approvals.ask(request)).resolves.toEqual({ outcome: "cancelled" });
  });
});
