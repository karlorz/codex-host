import { describe, expect, it } from "vitest";
import { grokCommandCatalog, grokGoalPrompt } from "../src/grok-commands.js";

describe("Grok native goals", () => {
  it("admits Desktop's opening /goal and retains the explicit /grok-goal command", () => {
    expect(grokCommandCatalog.commands).toContainEqual(
      expect.objectContaining({
        id: "grok.desktop-goal",
        invocation: "/goal",
        argumentMode: "text",
      }),
    );
    expect(grokCommandCatalog.commands).toContainEqual(
      expect.objectContaining({ id: "grok.goal", invocation: "/grok-goal", argumentMode: "text" }),
    );
  });
  it.each([
    [undefined, "/goal"],
    ["", "/goal"],
    ["status", "/goal status"],
    ["pause", "/goal pause"],
    ["resume", "/goal resume"],
    ["clear", "/goal clear"],
    [
      "  Fix the  build\nthen verify --budget 20000  ",
      "/goal Fix the  build\nthen verify --budget 20000",
    ],
  ])("keeps native argument semantics for %s", (text, expected) => {
    expect(grokGoalPrompt(text === undefined ? undefined : { text })).toEqual({
      ok: true,
      value: expected,
    });
  });
  it.each([{ text: 10 }, { budget: 20 }, { text: "status", extra: true }])(
    "rejects malformed arguments %j",
    (args) => {
      expect(grokGoalPrompt(args)).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    },
  );
});
