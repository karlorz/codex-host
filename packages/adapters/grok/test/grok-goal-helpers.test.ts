import { describe, expect, it } from "vitest";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import type { GrokTransportEvent } from "../src/acp-transport.js";
import { mapGrokReplay } from "../src/grok-history.js";
import { grokSubagentEventFromUpdate } from "../src/grok-subagent.js";

const harnessId = harnessIdSchema.parse("grok");
const spawn = (id: string, parentPromptId = "worker"): GrokTransportEvent => ({
  type: "subagent.spawned",
  nativeSubagentId: id,
  childSessionId: id,
  parentPromptId,
  attemptId: `attempt-${id}`,
  description: id,
  model: id === "planner" ? "grok-4.6" : "sonnet",
});
const finish = (
  id: string,
  status: "completed" | "interrupted" = "completed",
): GrokTransportEvent => ({
  type: "subagent.finished",
  nativeSubagentId: id,
  status,
});

describe("native goal helper history", () => {
  it("retains native ownership and attempt fields without turning general-purpose into a role", () => {
    expect(
      grokSubagentEventFromUpdate({
        sessionUpdate: "subagent_spawned",
        subagent_id: "planner",
        child_session_id: "child",
        parent_prompt_id: "worker",
        attempt_id: "attempt",
        subagent_type: "general-purpose",
        model: "sonnet",
        description: "plan",
      }),
    ).toEqual({
      type: "subagent.spawned",
      nativeSubagentId: "planner",
      childSessionId: "child",
      parentPromptId: "worker",
      attemptId: "attempt",
      model: "sonnet",
      description: "plan",
    });
  });
  it.each([false, true])(
    "places pre-input and post-terminal children into their actual owning Turn, cancelled=%s",
    (cancelled) => {
      const events: GrokTransportEvent[] = [
        spawn("planner"),
        finish("planner"),
        {
          type: "user.text",
          text: "<system-reminder>Goal</system-reminder>",
          metadata: { promptIndex: 0 },
        },
        { type: "agent.text", text: "Done" },
        spawn("skeptic-1"),
        finish("skeptic-1"),
        spawn("skeptic-2"),
        spawn("skeptic-2"),
        finish("skeptic-2"),
        spawn("skeptic-3"),
        finish("skeptic-3"),
      ];
      const terminal: GrokTransportEvent = {
        type: "turn.completed",
        nativeTurnKey: "worker",
        stopReason: cancelled ? "cancelled" : "end_turn",
      };
      if (cancelled) events.push(terminal);
      events.push(
        spawn("summarizer"),
        finish("summarizer", cancelled ? "interrupted" : "completed"),
      );
      if (!cancelled) events.push(terminal);
      const snapshot = mapGrokReplay(events, harnessId, "session", "/workspace");
      expect(snapshot.turns).toHaveLength(1);
      const children = (snapshot.turns[0]?.items ?? []).flatMap((s) =>
        s.item.type === "subagentDelegation" ? s.item.subagents : [],
      );
      expect(children.map((c) => c.nativeSubagentId)).toEqual([
        "planner",
        "skeptic-1",
        "skeptic-2",
        "skeptic-3",
        "summarizer",
      ]);
      expect(children.map((c) => c.model)).toEqual([
        "grok-4.6",
        "sonnet",
        "sonnet",
        "sonnet",
        "sonnet",
      ]);
      expect(children.at(-1)?.status).toBe(cancelled ? "interrupted" : "completed");
      expect((snapshot.turns[0]?.items ?? [])[0]?.item).toMatchObject({
        type: "subagentDelegation",
        subagents: [{ nativeSubagentId: "planner" }],
      });
    },
  );
  it("does not fabricate a Turn or attach an orphan helper to a different prompt", () => {
    const snapshot = mapGrokReplay(
      [
        spawn("orphan", "missing"),
        finish("orphan"),
        { type: "user.text", text: "visible" },
        { type: "turn.completed", nativeTurnKey: "other", stopReason: "end_turn" },
      ],
      harnessId,
      "session",
      "/workspace",
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items).toEqual([]);
  });
  it("does not resurrect removed helper history after rewind", () => {
    const snapshot = mapGrokReplay(
      [
        spawn("planner"),
        finish("planner"),
        { type: "user.text", text: "goal", metadata: { promptIndex: 0 } },
        { type: "turn.completed", nativeTurnKey: "worker", stopReason: "end_turn" },
        { type: "rewind.marker", targetPromptIndex: 0 },
        { type: "user.text", text: "replacement", metadata: { promptIndex: 0 } },
        { type: "turn.completed", nativeTurnKey: "replacement", stopReason: "end_turn" },
      ],
      harnessId,
      "session",
      "/workspace",
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items).toEqual([]);
  });
});
