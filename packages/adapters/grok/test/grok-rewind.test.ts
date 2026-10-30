import { describe, expect, it, vi } from "vitest";
import { mapGrokReplay } from "../src/grok-history.js";
import {
  harnessIdSchema,
  nativeSessionRefSchema,
  nativeCheckpointRefSchema,
} from "@codexhost/shared-contracts";
import type { GrokTransportEvent } from "../src/acp-transport.js";

import {
  GROK_REWIND_EXECUTE_METHOD,
  GROK_REWIND_POINTS_METHOD,
  buildGrokRewindParams,
  parseGrokRewindResponse,
  rewindGrokSession,
} from "../src/grok-rewind.js";

describe("Grok Rewind ACP envelope", () => {
  it("uses the underscore-prefixed wire method and conversation-only force params", () => {
    expect(GROK_REWIND_EXECUTE_METHOD).toBe("_x.ai/rewind/execute");
    expect(GROK_REWIND_POINTS_METHOD).toBe("_x.ai/rewind/points");
    expect(
      buildGrokRewindParams({
        sessionId: "session",
        targetPromptIndex: 0,
      }),
    ).toEqual({
      sessionId: "session",
      targetPromptIndex: 0,
      force: true,
      mode: "conversation_only",
    });
  });

  it("parses a successful top-level response and a result-wrapped response", () => {
    expect(
      parseGrokRewindResponse({
        success: true,
        target_prompt_index: 1,
        mode: "conversation_only",
        prompt_text: "previous",
      }),
    ).toEqual({
      success: true,
      targetPromptIndex: 1,
      mode: "conversation_only",
      promptText: "previous",
    });
    expect(parseGrokRewindResponse({ result: { success: true, targetPromptIndex: 0 } })).toEqual({
      success: true,
      targetPromptIndex: 0,
    });
  });

  it("parses an unsuccessful Rewind without treating it as a missing payload", () => {
    expect(
      parseGrokRewindResponse({
        success: false,
        target_prompt_index: 1,
        mode: "all",
        error: null,
      }),
    ).toEqual({
      success: false,
      targetPromptIndex: 1,
      mode: "all",
      error: null,
    });
  });

  it("rejects a missing success flag or Prompt Index", () => {
    expect(parseGrokRewindResponse({})).toBeNull();
    expect(parseGrokRewindResponse({ result: {} })).toBeNull();
    expect(parseGrokRewindResponse({ success: true })).toBeNull();
    expect(parseGrokRewindResponse({ success: true, targetPromptIndex: -1 })).toBeNull();
  });
});

describe("Grok checkpoint rewind", () => {
  const harnessId = harnessIdSchema.parse("grok");
  const sourceRef = nativeSessionRefSchema.parse({
    harnessId,
    nativeSessionId: "session",
    formatVersion: 1,
  });
  const history: GrokTransportEvent[] = [
    { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
    { type: "agent.text", text: "answer one" },
    { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    {
      type: "user.text",
      text: "<system-reminder>native goal continuation</system-reminder>",
      metadata: { eventId: "synthetic" },
    },
    { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
    { type: "agent.text", text: "answer two" },
    { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
    { type: "user.text", text: "third", metadata: { eventId: "user-3" } },
    { type: "agent.text", text: "answer three" },
    { type: "turn.completed", nativeTurnKey: "prompt-3", stopReason: "end_turn" },
  ];

  it.each([0, 2])(
    "rewinds directly to native prompt %i, including an empty prefix",
    async (targetPromptIndex) => {
      const events = [...history];
      const rewindAndLoad = vi.fn(async () => {
        events.push({ type: "rewind.marker", targetPromptIndex });
        return { sessionId: "session" };
      });
      const result = await rewindGrokSession({
        cwd: "/synthetic",
        harnessId,
        sourceRef,
        checkpoint: nativeCheckpointRefSchema.parse({
          harnessId,
          nativeSessionId: "session",
          checkpointId: String(targetPromptIndex),
          formatVersion: 1,
        }),
        locateSource: async () => ({ cwd: "/synthetic" }),
        readHistory: async () => events,
        rewindAndLoad,
      });
      expect(result).toEqual({ ok: true, value: { sessionId: "session" } });
      expect(rewindAndLoad).toHaveBeenCalledExactlyOnceWith({
        sessionId: "session",
        targetPromptIndex,
        force: true,
        mode: "conversation_only",
      });
    },
  );

  it.each([0, 1, 2])(
    "rewinds native background responses at checkpoint %i",
    async (targetPromptIndex) => {
      const events: GrokTransportEvent[] = [
        { type: "user.text", text: "first", metadata: { promptIndex: 0 } },
        { type: "turn.completed", nativeTurnKey: "first", stopReason: "end_turn" },
        {
          type: "user.text",
          text: "<system-reminder>Watch</system-reminder>",
          metadata: { promptIndex: 1 },
        },
        { type: "agent.text", text: "Observed" },
        {
          type: "turn.completed",
          nativeTurnKey: "subagent-completed-child",
          stopReason: "end_turn",
        },
        { type: "user.text", text: "last", metadata: { promptIndex: 2 } },
        { type: "turn.completed", nativeTurnKey: "last", stopReason: "end_turn" },
      ];
      const result = await rewindGrokSession({
        cwd: "/synthetic",
        harnessId,
        sourceRef,
        checkpoint: nativeCheckpointRefSchema.parse({
          harnessId,
          nativeSessionId: "session",
          checkpointId: String(targetPromptIndex),
          formatVersion: 1,
        }),
        locateSource: async () => ({ cwd: "/synthetic" }),
        readHistory: async () => events,
        rewindAndLoad: async () => {
          events.push({ type: "rewind.marker", targetPromptIndex });
          return { sessionId: "session" };
        },
      });
      expect(result).toMatchObject({ ok: true });
      expect(
        mapGrokReplay(events, harnessId, "session", "/synthetic").turns.map(
          (t) => t.nativeTurnRef.nativeTurnKey,
        ),
      ).toEqual(["first", "subagent-completed-child"].slice(0, targetPromptIndex));
    },
  );

  it.each(["another-session", "stale-checkpoint"])(
    "rejects %s before native mutation",
    async (invalid) => {
      const rewindAndLoad = vi.fn();
      const result = await rewindGrokSession({
        cwd: "/synthetic",
        harnessId,
        sourceRef,
        checkpoint: nativeCheckpointRefSchema.parse({
          harnessId,
          nativeSessionId: invalid === "another-session" ? invalid : "session",
          checkpointId: invalid === "stale-checkpoint" ? "999" : "0",
          formatVersion: 1,
        }),
        locateSource: async () => ({ cwd: "/synthetic" }),
        readHistory: async () => history,
        rewindAndLoad,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
      expect(rewindAndLoad).not.toHaveBeenCalled();
    },
  );

  it("rejects legacy local controls before any native history mutation", async () => {
    const rewindAndLoad = vi.fn();
    const result = await rewindGrokSession({
      cwd: "/synthetic",
      harnessId,
      sourceRef,
      locateSource: async () => ({ cwd: "/synthetic" }),
      readHistory: async () => [{ type: "user.text", text: "/goal status" }, ...history],
      rewindAndLoad,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(rewindAndLoad).not.toHaveBeenCalled();
  });

  it("rejects native success if the retained history is not the selected prefix", async () => {
    const result = await rewindGrokSession({
      cwd: "/synthetic",
      harnessId,
      sourceRef,
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId,
        nativeSessionId: "session",
        checkpointId: "2",
        formatVersion: 1,
      }),
      locateSource: async () => ({ cwd: "/synthetic" }),
      readHistory: async () => history,
      rewindAndLoad: async () => ({ sessionId: "session" }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "protocolError" } });
  });
});
