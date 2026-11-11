import { describe, expect, it } from "vitest";
import type { HostQuestionInteraction, HostToolExecutionItem } from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import { QuestionRecordStore } from "../src/question-records.js";

const thread = {};
const interaction: HostQuestionInteraction = {
  type: "question",
  interactionId: hostInteractionIdSchema.parse("ask-1"),
  turnId: hostTurnIdSchema.parse("turn-1"),
  title: "Grok",
  questions: [
    {
      id: "letters",
      type: "choice",
      prompt: "Letters?",
      multiple: true,
      allowOther: true,
      optional: false,
      options: [{ value: "a", label: "Alpha" }],
    },
    {
      id: "secret",
      type: "text",
      prompt: "Token",
      multiline: false,
      secret: true,
      optional: true,
    },
  ],
};

describe("QuestionRecordStore", () => {
  it("drops secret fields, locks user outcomes, and merges Adapter history", () => {
    const store = new QuestionRecordStore();
    store.record(thread, {
      interaction,
      itemId: "item-live",
      outcome: "answered",
      answers: { letters: ["a"], secret: ["hidden"] },
    });
    expect(store.list(thread)).toMatchObject([
      {
        interactionId: "ask-1",
        itemId: "item-live",
        outcome: "answered",
        answers: { letters: ["a"] },
      },
    ]);
    expect(store.list(thread)[0]?.questions.some((field) => field.id === "secret")).toBe(false);

    store.record(thread, {
      interaction,
      itemId: "item-live",
      outcome: "closedByHarness",
      answers: {},
    });
    expect(store.list(thread)[0]?.outcome).toBe("answered");

    const history: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: hostItemIdSchema.parse("item-history"),
      toolName: "AskUserQuestion",
      arguments: {},
      questionRecord: {
        title: "Claude Code",
        questions: [
          {
            id: "question-1",
            type: "choice",
            prompt: "Ship it?",
            multiple: false,
            allowOther: true,
            optional: false,
            options: [{ value: "yes", label: "Yes" }],
          },
        ],
        outcome: "answered",
        answers: { "question-1": ["yes"] },
      },
    };
    store.ingest(thread, hostTurnIdSchema.parse("turn-2"), history);
    expect(store.list(thread).map((record) => record.itemId)).toEqual([
      "item-live",
      "item-history",
    ]);
    expect(store.list(undefined)).toEqual([]);

    const restored = {};
    store.ingestHistory(restored, [
      { turnId: "turn-2", items: [history] },
      {
        turnId: "turn-3",
        items: [{ type: "agentMessage", itemId: hostItemIdSchema.parse("msg"), text: "done" }],
      },
    ]);
    expect(store.list(restored).map((record) => record.itemId)).toEqual(["item-history"]);
  });

  it("does not treat a native timeout label as a later user answer overwrite", () => {
    const store = new QuestionRecordStore();
    store.record(thread, {
      interaction,
      itemId: "item-live",
      outcome: "expired",
      answers: {},
    });
    store.record(thread, {
      interaction,
      itemId: "item-live",
      outcome: "answered",
      answers: { letters: ["a"] },
    });
    expect(store.list(thread)[0]).toMatchObject({ outcome: "expired", answers: {} });
  });
});
