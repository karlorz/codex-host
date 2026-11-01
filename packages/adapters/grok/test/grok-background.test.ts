import { describe, expect, it } from "vitest";

import {
  applyGrokScheduledEvent,
  collectGrokScheduledLoops,
  grokBackgroundCompletionOutcome,
  grokBackgroundEventFromUpdate,
  grokBackgroundTaskId,
  grokToolIsBackgrounded,
  isGrokBackgroundNotificationMethod,
} from "../src/grok-background.js";

describe("Grok background native mapping", () => {
  it("recognizes dedicated ACP notification methods", () => {
    expect(isGrokBackgroundNotificationMethod("x.ai/task_backgrounded")).toBe(true);
    expect(isGrokBackgroundNotificationMethod("x.ai/monitor_event")).toBe(true);
    expect(isGrokBackgroundNotificationMethod("x.ai/scheduled_task_created")).toBe(true);
    expect(isGrokBackgroundNotificationMethod("x.ai/session_notification")).toBe(false);
  });

  it("parses a Run task_backgrounded update and a Monitor by monitor_description", () => {
    expect(
      grokBackgroundEventFromUpdate({
        sessionUpdate: "task_backgrounded",
        tool_call_id: "call-1",
        task_id: "task-1",
        command: "sleep 30",
        cwd: "/tmp",
        output_file: "/tmp/out.log",
        description: "wait for server",
      }),
    ).toMatchObject({
      type: "task.backgrounded",
      toolCallId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "wait for server",
    });
    expect(
      grokBackgroundEventFromUpdate({
        sessionUpdate: "task_backgrounded",
        toolCallId: "call-2",
        taskId: "mon-1",
        command: "tail -f log",
        monitorDescription: "watch build log",
      }),
    ).toMatchObject({ type: "task.backgrounded", kind: "monitor", description: "watch build log" });
  });

  it("parses loop created/fired/deleted and keeps next-run identity", () => {
    const loops = collectGrokScheduledLoops(
      [
        grokBackgroundEventFromUpdate({
          sessionUpdate: "scheduled_task_created",
          task_id: "loop-1",
          prompt: "Observe-only health",
          human_schedule: "every 15 minutes",
          next_fire_at: "2026-11-01T05:15:00Z",
        }),
        grokBackgroundEventFromUpdate({
          sessionUpdate: "scheduled_task_fired",
          task_id: "loop-1",
          prompt: "Observe-only health",
          human_schedule: "every 15 minutes",
          next_fire_at: "2026-11-01T05:30:00Z",
          subagent_id: "child-9",
        }),
      ].filter((event) => event !== null),
    );
    expect(loops.get("loop-1")).toMatchObject({
      taskId: "loop-1",
      humanSchedule: "every 15 minutes",
      nextFireAt: "2026-11-01T05:30:00Z",
      lastSubagentId: "child-9",
    });
    const deleted = grokBackgroundEventFromUpdate({
      sessionUpdate: "scheduled_task_deleted",
      task_id: "loop-1",
      reason: "cancelled",
    });
    if (!deleted || deleted.type !== "scheduled.deleted")
      throw new Error("Missing native deletion");
    applyGrokScheduledEvent(loops, deleted);
    expect(loops.size).toBe(0);
  });

  it("does not treat process tasks as child agents and maps kill outcomes", () => {
    expect(grokToolIsBackgrounded({ signal: "backgrounded" })).toBe(true);
    expect(grokToolIsBackgrounded({ task_id: "t-1" })).toBe(true);
    expect(grokToolIsBackgrounded({ exit_code: 0, task_id: "t-1" })).toBe(false);
    expect(grokBackgroundTaskId({ taskId: "t-2" })).toBe("t-2");
    expect(grokBackgroundCompletionOutcome({ explicitlyKilled: true }).status).toBe("cancelled");
    expect(grokBackgroundCompletionOutcome({ exitCode: 0 }).status).toBe("succeeded");
  });
});
