import { describe, expect, it } from "vitest";

import { grokQuestionRecordFromTool } from "../src/grok-question-record.js";

const input = {
  questions: [
    {
      question: "Which letter?",
      multiSelect: true,
      options: [
        { label: "Alpha", description: "First", preview: "Alpha preview" },
        { label: "Beta", description: "Second" },
      ],
    },
  ],
};

describe("Grok AskUserQuestion history records", () => {
  it("maps accepted, cancelled, and failed native tools", () => {
    expect(
      grokQuestionRecordFromTool("read_file", input, { outcome: "accepted" }, "completed"),
    ).toBeUndefined();
    expect(
      grokQuestionRecordFromTool(
        "_x.ai/ask_user_question",
        input,
        { outcome: "accepted", answers: { "Which letter?": ["Alpha"] } },
        "completed",
      ),
    ).toMatchObject({
      title: "Grok",
      outcome: "answered",
      answers: { q0: ["Alpha"] },
      questions: [
        {
          id: "q0",
          multiple: true,
          allowOther: true,
          options: [{ value: "Alpha", description: "First\n\nAlpha preview" }, { value: "Beta" }],
        },
      ],
    });
    expect(
      grokQuestionRecordFromTool("AskUserQuestion", input, { outcome: "cancelled" }, "completed"),
    ).toMatchObject({ outcome: "skipped", answers: {} });
    expect(
      grokQuestionRecordFromTool("ask_user_question", input, undefined, "failed"),
    ).toMatchObject({ outcome: "closedByHarness", answers: {} });
  });

  it("parses JSON string output and does not invent answers", () => {
    expect(
      grokQuestionRecordFromTool(
        "_x.ai/ask_user_question",
        input,
        JSON.stringify({ outcome: "accepted", answers: { q0: ["Beta"] } }),
        "completed",
      ),
    ).toMatchObject({ outcome: "answered", answers: { q0: ["Beta"] } });
    expect(
      grokQuestionRecordFromTool(
        "_x.ai/ask_user_question",
        input,
        { outcome: "accepted" },
        "completed",
      ),
    ).toMatchObject({ outcome: "closedByHarness", answers: {} });
  });

  it("maps native AskUserQuestion.UserAnswered history", () => {
    expect(
      grokQuestionRecordFromTool(
        "ask_user_question",
        input,
        {
          type: "AskUserQuestion",
          UserAnswered: {
            message:
              'User has answered your questions: "Which letter?"="Alpha, Beta". You can now continue with the user\'s answers in mind.',
          },
        },
        "completed",
      ),
    ).toMatchObject({ outcome: "answered", answers: { q0: ["Alpha", "Beta"] } });
    expect(
      grokQuestionRecordFromTool(
        "ask_user_question",
        input,
        {
          type: "AskUserQuestion",
          UserAnswered: {
            message:
              "User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.",
          },
        },
        "completed",
      ),
    ).toMatchObject({ outcome: "skipped", answers: {} });
    expect(
      grokQuestionRecordFromTool(
        "ask_user_question",
        input,
        {
          type: "AskUserQuestion",
          UserAnswered: {
            message:
              "User has answered your questions: . You can now continue with the user's answers in mind.",
          },
        },
        "completed",
      ),
    ).toMatchObject({ outcome: "answered", answers: {} });
  });
});
