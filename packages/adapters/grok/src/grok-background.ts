import type { HostItemOutcome } from "@codexhost/harness-adapter";

export const GROK_TASK_KILL_METHOD = "x.ai/task/kill";
export const GROK_TASK_LIST_METHOD = "x.ai/task/list";
export const GROK_SCHEDULER_DELETE_METHOD = "x.ai/scheduler/delete";

export const GROK_BACKGROUND_NOTIFICATION_METHODS = [
  "x.ai/task_backgrounded",
  "_x.ai/task_backgrounded",
  "x.ai/task_completed",
  "_x.ai/task_completed",
  "x.ai/monitor_event",
  "_x.ai/monitor_event",
  "x.ai/scheduled_task_created",
  "_x.ai/scheduled_task_created",
  "x.ai/scheduled_task_fired",
  "_x.ai/scheduled_task_fired",
  "x.ai/scheduled_task_deleted",
  "_x.ai/scheduled_task_deleted",
] as const;

const BACKGROUND_SESSION_UPDATES = new Set([
  "task_backgrounded",
  "task_completed",
  "monitor_event",
  "scheduled_task_created",
  "scheduled_task_fired",
  "scheduled_task_deleted",
]);

export type GrokBackgroundKind = "run" | "monitor";

export type GrokBackgroundTransportEvent =
  | {
      type: "task.backgrounded";
      toolCallId: string;
      taskId: string;
      command: string;
      cwd?: string;
      outputFile?: string;
      kind: GrokBackgroundKind;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "task.completed";
      taskId: string;
      command?: string;
      kind?: GrokBackgroundKind;
      description?: string;
      output?: string;
      outputFile?: string;
      truncated?: boolean;
      exitCode?: number | null;
      signal?: string;
      explicitlyKilled?: boolean;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "monitor.event";
      taskId: string;
      description?: string;
      text: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "scheduled.created";
      taskId: string;
      prompt: string;
      humanSchedule: string;
      nextFireAt?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "scheduled.fired";
      taskId: string;
      prompt: string;
      humanSchedule: string;
      nextFireAt?: string;
      subagentId?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "scheduled.deleted";
      taskId: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    };

export interface GrokScheduledLoop {
  taskId: string;
  prompt: string;
  humanSchedule: string;
  nextFireAt?: string;
  lastSubagentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstPresent(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = firstPresent(record, keys);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  const value = firstPresent(record, keys);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null | undefined {
  const value = firstPresent(record, keys);
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  const value = firstPresent(record, keys);
  return typeof value === "boolean" ? value : undefined;
}

function snapshotRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value.task_snapshot ?? value.taskSnapshot;
  return isRecord(nested) ? nested : value;
}

function backgroundKind(value: unknown, monitorDescription?: string): GrokBackgroundKind {
  if (monitorDescription) return "monitor";
  if (typeof value === "string" && value.toLowerCase() === "monitor") return "monitor";
  return "run";
}

export function isGrokBackgroundNotificationMethod(method: string): boolean {
  return (GROK_BACKGROUND_NOTIFICATION_METHODS as readonly string[]).includes(method);
}

function fields<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

export function grokBackgroundEventFromUpdate(
  update: unknown,
): GrokBackgroundTransportEvent | null {
  if (
    !isRecord(update) ||
    typeof update.sessionUpdate !== "string" ||
    !BACKGROUND_SESSION_UPDATES.has(update.sessionUpdate)
  )
    return null;
  const taskId = stringField(update, ["task_id", "taskId"]);
  if (update.sessionUpdate === "task_backgrounded") {
    const toolCallId = stringField(update, ["tool_call_id", "toolCallId"]);
    const command = stringField(update, ["command"]);
    if (!taskId || !toolCallId || !command) return null;
    const monitorDescription = optionalString(update, [
      "monitor_description",
      "monitorDescription",
    ]);
    return {
      type: "task.backgrounded",
      taskId,
      toolCallId,
      command,
      kind: backgroundKind(undefined, monitorDescription),
      ...fields({
        cwd: optionalString(update, ["cwd"]),
        outputFile: optionalString(update, ["output_file", "outputFile"]),
        description: monitorDescription ?? optionalString(update, ["description"]),
      }),
    };
  }
  if (update.sessionUpdate === "task_completed") {
    const snapshot = snapshotRecord(
      firstPresent(update, ["task_snapshot", "taskSnapshot"]) ?? update,
    );
    const id = snapshot && stringField(snapshot, ["task_id", "taskId"]);
    if (!snapshot || !id) return null;
    return {
      type: "task.completed",
      taskId: id,
      kind: backgroundKind(snapshot.kind),
      ...fields({
        command: optionalString(snapshot, ["command"]),
        description: optionalString(snapshot, ["description", "display_command", "displayCommand"]),
        output: optionalString(snapshot, ["output"]),
        outputFile: optionalString(snapshot, ["output_file", "outputFile"]),
        truncated: booleanField(snapshot, ["truncated"]),
        exitCode: numberField(snapshot, ["exit_code", "exitCode"]),
        signal: optionalString(snapshot, ["signal"]),
        explicitlyKilled: booleanField(snapshot, ["explicitly_killed", "explicitlyKilled"]),
      }),
    };
  }
  if (!taskId) return null;
  if (update.sessionUpdate === "monitor_event") {
    const text = optionalString(update, ["event_text", "eventText"]);
    return text === undefined
      ? null
      : {
          type: "monitor.event",
          taskId,
          text,
          ...fields({ description: optionalString(update, ["description"]) }),
        };
  }
  if (
    update.sessionUpdate === "scheduled_task_created" ||
    update.sessionUpdate === "scheduled_task_fired"
  ) {
    const prompt = optionalString(update, ["prompt"]);
    const humanSchedule = optionalString(update, ["human_schedule", "humanSchedule"]);
    if (prompt === undefined || !humanSchedule) return null;
    const next = optionalString(update, ["next_fire_at", "nextFireAt"]);
    const common = {
      taskId,
      prompt,
      humanSchedule,
      ...fields({ nextFireAt: next && Number.isFinite(Date.parse(next)) ? next : undefined }),
    };
    return update.sessionUpdate === "scheduled_task_created"
      ? { type: "scheduled.created", ...common }
      : {
          type: "scheduled.fired",
          ...common,
          ...fields({ subagentId: stringField(update, ["subagent_id", "subagentId"]) }),
        };
  }
  if (update.sessionUpdate === "scheduled_task_deleted")
    return {
      type: "scheduled.deleted",
      taskId,
      ...fields({ reason: optionalString(update, ["reason"]) }),
    };
  return null;
}

export function grokToolIsBackgrounded(rawOutput: unknown, rawInput?: unknown): boolean {
  const exitCode = isRecord(rawOutput)
    ? numberField(rawOutput, ["exit_code", "exitCode"])
    : undefined;
  if (exitCode !== undefined && exitCode !== null) return false;
  if (isRecord(rawOutput) && optionalString(rawOutput, ["signal"]) === "backgrounded") return true;
  if (grokBackgroundTaskId(rawOutput, rawInput)) return true;
  return Boolean(
    isRecord(rawInput) && (rawInput.background === true || rawInput.is_background === true),
  );
}

export function grokBackgroundTaskId(rawOutput: unknown, rawInput?: unknown): string | undefined {
  if (isRecord(rawOutput)) {
    const id = stringField(rawOutput, ["task_id", "taskId"]);
    if (id) return id;
  }
  if (isRecord(rawInput)) return stringField(rawInput, ["task_id", "taskId"]);
  return undefined;
}

export function grokBackgroundCompletionOutcome(event: {
  exitCode?: number | null;
  signal?: string;
  explicitlyKilled?: boolean;
}): HostItemOutcome {
  if (event.explicitlyKilled || event.signal === "killed" || event.signal === "session_restart") {
    return { status: "cancelled", reason: "Background command stopped" };
  }
  if (event.exitCode === 0) {
    return { status: "succeeded" };
  }
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: event.signal
        ? `Grok background command ended with signal ${event.signal}`
        : `Grok background command exited ${event.exitCode}`,
      retryable: false,
    },
  };
}

export function applyGrokScheduledEvent(
  loops: Map<string, GrokScheduledLoop>,
  event: Extract<
    GrokBackgroundTransportEvent,
    { type: "scheduled.created" | "scheduled.fired" | "scheduled.deleted" }
  >,
  observedIds?: Set<string>,
): void {
  observedIds?.add(event.taskId);
  if (event.type === "scheduled.deleted") {
    loops.delete(event.taskId);
    return;
  }
  const current = loops.get(event.taskId);
  loops.set(event.taskId, {
    taskId: event.taskId,
    prompt: event.prompt,
    humanSchedule: event.humanSchedule,
    ...(event.nextFireAt ? { nextFireAt: event.nextFireAt } : {}),
    ...(event.type === "scheduled.fired" && event.subagentId
      ? { lastSubagentId: event.subagentId }
      : current?.lastSubagentId
        ? { lastSubagentId: current.lastSubagentId }
        : {}),
  });
}

export function collectGrokScheduledTaskIds(
  events: readonly { type: string; taskId?: string }[],
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (
      (event.type === "scheduled.created" || event.type === "scheduled.fired") &&
      typeof event.taskId === "string"
    ) {
      ids.add(event.taskId);
    }
  }
  return ids;
}

export function collectGrokScheduledLoops(
  events: readonly { type: string }[],
): Map<string, GrokScheduledLoop> {
  const loops = new Map<string, GrokScheduledLoop>();
  for (const event of events) {
    if (
      event.type === "scheduled.created" ||
      event.type === "scheduled.fired" ||
      event.type === "scheduled.deleted"
    ) {
      applyGrokScheduledEvent(
        loops,
        event as Extract<
          GrokBackgroundTransportEvent,
          { type: "scheduled.created" | "scheduled.fired" | "scheduled.deleted" }
        >,
      );
    }
  }
  return loops;
}
