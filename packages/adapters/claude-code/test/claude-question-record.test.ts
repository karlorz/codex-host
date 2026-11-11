import { describe, expect, it } from "vitest";

import { claudeAskUserQuestionRecord } from "../src/claude-question-record.js";

const input = {
  questions: [
    {
      question: "Ship it?",
      header: "Release",
      options: [
        { label: "Yes", description: "Ship" },
        { label: "No", description: "Hold" },
      ],
      multiSelect: false,
    },
  ],
};

describe("Claude AskUserQuestion history records", () => {
  it("maps native answers, skip, and failures without guessing other tools", () => {
    expect(claudeAskUserQuestionRecord("Read", input, '{"Ship it?":"Yes"}', false)).toBeUndefined();
    expect(
      claudeAskUserQuestionRecord("AskUserQuestion", input, '{"Ship it?":"Yes"}', false),
    ).toMatchObject({
      title: "Release",
      outcome: "answered",
      answers: { "question-1": ["Yes"] },
      questions: [{ id: "question-1", prompt: "Ship it?", allowOther: true, multiple: false }],
    });
    expect(claudeAskUserQuestionRecord("AskUserQuestion", input, undefined, false)).toMatchObject({
      outcome: "skipped",
      answers: {},
    });
    expect(
      claudeAskUserQuestionRecord("AskUserQuestion", input, '{"Ship it?":"Yes"}', true),
    ).toMatchObject({ outcome: "closedByHarness", answers: { "question-1": ["Yes"] } });
  });

  it("splits native comma-joined multi-select answers", () => {
    const multi = {
      questions: [
        {
          question: "Letters?",
          options: [{ label: "Alpha" }, { label: "Beta" }],
          multiSelect: true,
        },
      ],
    };
    expect(
      claudeAskUserQuestionRecord(
        "AskUserQuestion",
        multi,
        'User answered\n{"Letters?":"Alpha, Beta"}',
        false,
      ),
    ).toMatchObject({
      title: "Claude Code",
      outcome: "answered",
      answers: { "question-1": ["Alpha", "Beta"] },
    });
  });

  it("maps native prose answers and toolUseResult.answers", () => {
    const letters = {
      questions: [
        {
          question: "Which letters?",
          header: "Letters",
          options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
          multiSelect: true,
        },
      ],
    };
    expect(
      claudeAskUserQuestionRecord(
        "AskUserQuestion",
        letters,
        'Your questions have been answered: "Which letters?"="Alpha, Beta". You can now continue with these answers in mind.',
        false,
      ),
    ).toMatchObject({
      title: "Letters",
      outcome: "answered",
      answers: { "question-1": ["Alpha", "Beta"] },
    });
    expect(
      claudeAskUserQuestionRecord("AskUserQuestion", letters, undefined, false, {
        answers: { "Which letters?": "Alpha, Beta" },
      }),
    ).toMatchObject({
      outcome: "answered",
      answers: { "question-1": ["Alpha", "Beta"] },
    });
  });

  it("maps native cancel as a skip", () => {
    expect(
      claudeAskUserQuestionRecord(
        "AskUserQuestion",
        input,
        "User cancelled the Question",
        true,
        "Error: User cancelled the Question",
      ),
    ).toMatchObject({ outcome: "skipped", answers: {} });
  });
});
