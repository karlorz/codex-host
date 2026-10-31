import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { projectHistoricalTurn } from "@codexhost/protocol-core";
import { readGrokNativeHistory, type GrokTransportEvent } from "../src/acp-transport.js";
import { lastCompletedGrokGoal } from "../src/grok-goal-history.js";
import { mapGrokReplay } from "../src/grok-history.js";
import { GrokGoals } from "../src/grok-goals.js";

const objective = "Write the smoke file, then stop.";
const creation: GrokTransportEvent = {
  type: "goal.changed",
  update: { goal_id: "goal", objective, status: "active", last_event: "goal_created" },
  metadata: { agentTimestampMs: 100_000 },
};
const completion: GrokTransportEvent = {
  type: "goal.changed",
  update: { goal_id: "goal", objective, status: "complete", tokens_used: 123, elapsed_ms: 275314 },
  metadata: { agentTimestampMs: 375_314 },
};
const replay: GrokTransportEvent[] = [
  creation,
  {
    type: "user.text",
    text: "<system-reminder>Internal goal instructions</system-reminder>",
    metadata: { promptIndex: 0, agentTimestampMs: 180_000 },
  },
  { type: "agent.text", text: "Verified the smoke file." },
  completion,
  {
    type: "turn.completed",
    nativeTurnKey: "worker",
    stopReason: "end_turn",
    metadata: { agentTimestampMs: 385_000 },
  },
  { type: "goal.changed", update: { goal_id: "", status: "cleared" } },
];

it("restores the goal request and worker timing from native evidence after clear", () => {
  const snapshot = mapGrokReplay(replay, harnessIdSchema.parse("grok"), "session", "/workspace");
  expect(snapshot.turns).toHaveLength(1);
  expect(snapshot.turns[0]).toMatchObject({
    input: [{ type: "text", text: `/goal ${objective}` }],
    startedAtMs: 180_000,
    completedAtMs: 385_000,
    checkpoint: { checkpointId: "0" },
    nativeTurnRef: { nativeTurnKey: "worker" },
  });
  expect(JSON.stringify(snapshot)).not.toContain("Internal goal instructions");
});

it("keeps continuation reminders hidden instead of repeating the user's goal", () => {
  const events: GrokTransportEvent[] = [
    ...replay.slice(0, -1),
    { ...creation, update: { ...creation.update, status: "complete" } },
    {
      type: "user.text",
      text: "<system-reminder>Continue</system-reminder>",
      metadata: { promptIndex: 1 },
    },
    { type: "agent.text", text: "Follow-up." },
    { type: "turn.completed", nativeTurnKey: "follow-up", stopReason: "end_turn" },
  ];
  const snapshot = mapGrokReplay(events, harnessIdSchema.parse("grok"), "session", "/workspace");
  expect(snapshot.turns.map((turn) => turn.input)).toEqual([
    [{ type: "text", text: `/goal ${objective}` }],
    [],
  ]);
});

it("retains completion accounting after clear without treating it as a current goal", () => {
  expect(lastCompletedGrokGoal(replay)).toEqual({
    objective,
    status: "complete",
    tokenBudget: null,
    tokensUsed: 123,
    timeUsedSeconds: 275,
    createdAt: 100,
    updatedAt: 375,
  });
  expect(
    lastCompletedGrokGoal([
      ...replay,
      { ...creation, update: { ...creation.update, goal_id: "new" } },
    ]),
  ).toBeNull();
  expect(
    lastCompletedGrokGoal([...replay, { type: "rewind.marker", targetPromptIndex: 0 }]),
  ).toBeNull();
  expect(lastCompletedGrokGoal([completion])).toBeNull();
  expect(
    lastCompletedGrokGoal([
      creation,
      { ...completion, update: { ...completion.update, goal_id: "" } },
    ]),
  ).toBeNull();
});

it("reads the original request, native timing and cleared completion from disk without native controls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-goal-reopen-"));
  const directory = path.join(root, "sessions", encodeURIComponent(root), "session");
  try {
    await mkdir(directory, { recursive: true });
    const records = [
      {
        timestamp: 100,
        params: {
          sessionId: "session",
          update: { sessionUpdate: "goal_updated", ...creation.update },
        },
      },
      {
        timestamp: 179,
        params: {
          sessionId: "session",
          _meta: { agentTimestampMs: 180_000, promptIndex: 0 },
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "<system-reminder>Native worker</system-reminder>" },
          },
        },
      },
      {
        timestamp: 181,
        params: {
          sessionId: "session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Verified." },
          },
        },
      },
      {
        timestamp: 375.314,
        params: {
          sessionId: "session",
          update: { sessionUpdate: "goal_updated", ...completion.update },
        },
      },
      {
        timestamp: 385,
        params: {
          sessionId: "session",
          update: { sessionUpdate: "turn_completed", prompt_id: "worker", stop_reason: "end_turn" },
        },
      },
      {
        timestamp: 386,
        params: { sessionId: "session", update: { sessionUpdate: "goal_cleared" } },
      },
    ];
    await writeFile(
      path.join(directory, "updates.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
    const history = await readGrokNativeHistory(
      { cwd: root, environment: { GROK_HOME: root } },
      "session",
    );
    const snapshot = mapGrokReplay(history, harnessIdSchema.parse("grok"), "session", root);
    expect(snapshot.turns).toHaveLength(1);
    const turn = snapshot.turns[0];
    if (!turn) throw new Error("Missing native worker Turn");
    expect(turn.input).toEqual([{ type: "text", text: `/goal ${objective}` }]);
    expect(
      projectHistoricalTurn({
        threadId: "thread",
        turnId: hostTurnIdSchema.parse("turn"),
        cwd: root,
        snapshot: turn,
      }),
    ).toMatchObject({
      startedAt: 180,
      completedAt: 385,
      durationMs: 205_000,
    });
    const goals = new GrokGoals(
      directory,
      async () => {
        throw new Error("Must not call native control");
      },
      () => {
        throw new Error("Must not emit live changes");
      },
      30_000,
      async () => history,
    );
    expect(await goals.read()).toEqual({ ok: true, value: null });
    expect(await goals.readLastCompleted()).toMatchObject({
      ok: true,
      value: {
        status: "complete",
        objective,
        createdAt: 100,
        updatedAt: 375,
        timeUsedSeconds: 275,
      },
    });
    goals.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
