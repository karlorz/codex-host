import { describe, expect, it } from "vitest";
import {
  threadQuestionsResultSchema,
  threadQuestionRespondParamsSchema,
  questionAutoResolutionSchema,
  threadQuestionActivityParamsSchema,
  threadQuestionActivityResultSchema,
} from "../src/index.js";

describe("shared question contracts", () => {
  it("accepts acknowledged activity without answer data or an inferred deadline", () => {
    const params = { threadId: "thread", turnId: "turn", interactionId: "question" };
    expect(threadQuestionActivityParamsSchema.parse(params)).toEqual(params);
    expect(threadQuestionActivityParamsSchema.safeParse({ ...params, answers: {} }).success).toBe(
      false,
    );
    expect(threadQuestionActivityParamsSchema.safeParse({ ...params, turnId: "" }).success).toBe(
      false,
    );
    expect(threadQuestionActivityResultSchema.parse({ autoResolution: null })).toEqual({
      autoResolution: null,
    });
    const autoResolution = { deadlineUnixMs: 1234, action: "recommended", resetOnActivity: true };
    expect(threadQuestionActivityResultSchema.parse({ autoResolution })).toEqual({
      autoResolution,
    });
    expect(
      questionAutoResolutionSchema.safeParse({ ...autoResolution, resetOnActivity: "true" })
        .success,
    ).toBe(false);
  });
  it("bounds native display deadlines and accepts only declared expiry actions", () => {
    expect(questionAutoResolutionSchema.parse({ deadlineUnixMs: 0, action: "decline" })).toEqual({
      deadlineUnixMs: 0,
      action: "decline",
    });
    for (const deadlineUnixMs of [-1, NaN, Infinity, 1.5, 8_640_000_000_000_001])
      expect(
        questionAutoResolutionSchema.safeParse({ deadlineUnixMs, action: "recommended" }).success,
      ).toBe(false);
    expect(
      questionAutoResolutionSchema.safeParse({ deadlineUnixMs: 1, action: "accept" }).success,
    ).toBe(false);
  });
  it("accepts multiple Host values and rejects arbitrary actions and untyped values", () => {
    const value = {
      threadId: "thread",
      turnId: "turn",
      interactionId: "question",
      answers: { letters: ["a", "g"] },
    };
    expect(threadQuestionRespondParamsSchema.parse(value)).toEqual(value);
    expect(threadQuestionRespondParamsSchema.safeParse({ ...value, method: "shell" }).success).toBe(
      false,
    );
    expect(
      threadQuestionRespondParamsSchema.safeParse({ ...value, answers: { letters: "a,g" } })
        .success,
    ).toBe(false);
    expect(threadQuestionRespondParamsSchema.safeParse({ ...value, turnId: "" }).success).toBe(
      false,
    );
  });
  it("does not expose secret question fields through the custom card API", () => {
    const base = {
      interactionId: "q",
      turnId: "t",
      questions: [
        {
          id: "text",
          type: "text",
          prompt: "Secret",
          optional: true,
          multiline: false,
          secret: true,
        },
      ],
    };
    expect(threadQuestionsResultSchema.safeParse({ questions: [base] }).success).toBe(false);
    expect(
      threadQuestionsResultSchema.safeParse({
        questions: [{ ...base, questions: [{ ...base.questions[0], secret: false }] }],
      }).success,
    ).toBe(true);
  });
});
