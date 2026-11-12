import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessBackgroundActivityCapability,
  HarnessResult,
  HostSubagentState,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import type {
  BackgroundActivity,
  BackgroundActivityDetail,
  BackgroundActivityStopResult,
  HostItemId,
} from "@codexhost/shared-contracts";
import type { GrokScheduledLoop } from "./grok-background.js";
import { tagGrokScheduledActivityChildren } from "./grok-scheduled-origin.js";

export interface GrokTaskSnapshot {
  task_id: string;
  command: string;
  kind?: string;
  description?: string;
  output: string;
  truncated: boolean;
  completed: boolean;
  explicitly_killed?: boolean;
  exit_code?: number | null;
  signal?: string | null;
  owner_session_id?: string;
  is_backgrounded?: boolean;
}
/** Newest settled child rows; each loop's lastSubagentId stays even outside this cap. */
const SETTLED_SUBAGENT_ACTIVITY_LIMIT = 20;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function isActiveChild(status: HostSubagentState["status"]) {
  return status === "pending" || status === "running";
}
const fail = (
  code: "nativeFailure" | "unsupported" | "invalidRequest" | "protocolError",
  message: string,
): HarnessResult<never> => ({ ok: false, error: { code, message, retryable: false } });

export function parseGrokTaskList(value: unknown, sessionId: string): GrokTaskSnapshot[] {
  if (!record(value) || !Array.isArray(value.tasks)) throw new Error("Malformed Grok task list");
  return value.tasks
    .map((entry): GrokTaskSnapshot => {
      if (
        !record(entry) ||
        typeof entry.task_id !== "string" ||
        typeof entry.command !== "string" ||
        typeof entry.output !== "string" ||
        typeof entry.completed !== "boolean" ||
        typeof entry.truncated !== "boolean"
      )
        throw new Error("Malformed Grok task snapshot");
      return entry as unknown as GrokTaskSnapshot;
    })
    .filter(
      (entry) =>
        (!entry.owner_session_id || entry.owner_session_id === sessionId) &&
        entry.is_backgrounded === true,
    );
}

/** Reads native scheduler persistence; never advances its cadence or dispatches work. */
export async function readGrokScheduledLoops(
  directory: string,
): Promise<Map<string, GrokScheduledLoop> | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(directory, "resources_state.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!record(raw) || !record(raw.state)) throw new Error("Malformed Grok resource state");
  const scheduler = raw.state["grok_build.Scheduler"];
  if (scheduler === undefined) return new Map();
  if (!record(scheduler) || !Array.isArray(scheduler.tasks))
    throw new Error("Malformed Grok scheduler state");
  const loops = new Map<string, GrokScheduledLoop>();
  for (const task of scheduler.tasks) {
    if (
      !record(task) ||
      typeof task.id !== "string" ||
      typeof task.prompt !== "string" ||
      typeof task.intervalSecs !== "number" ||
      task.intervalSecs <= 0
    )
      throw new Error("Malformed Grok scheduled task");
    const anchor = typeof task.lastFiredAt === "string" ? task.lastFiredAt : task.createdAt;
    const next = typeof anchor === "string" ? Date.parse(anchor) + task.intervalSecs * 1000 : NaN;
    loops.set(task.id, {
      taskId: task.id,
      prompt: task.prompt,
      humanSchedule: `every ${task.intervalSecs} seconds`,
      ...((task.recurring !== false || task.lastFiredAt == null) &&
      (typeof task.expiresAt !== "string" || Date.parse(task.expiresAt) > Date.now()) &&
      Number.isFinite(next)
        ? { nextFireAt: new Date(next).toISOString() }
        : {}),
      ...(typeof task.lastSubagentId === "string" ? { lastSubagentId: task.lastSubagentId } : {}),
    });
  }
  return loops;
}

export function createGrokActivity(options: {
  sessionId: string;
  directory: string;
  loops: Map<string, GrokScheduledLoop>;
  observedLoopIds: Set<string>;
  children: Map<string, HostSubagentState>;
  listTasks?: () => Promise<unknown>;
  killTask?: (id: string) => Promise<"killed" | "already_exited" | "not_found">;
  deleteLoop?: (id: string) => Promise<boolean>;
  getChild?(id: string): Promise<unknown>;
  readChild(id: string): Promise<HarnessResult<HostThreadSnapshot>>;
  outputLimit: number;
  observeTasks?(tasks: readonly GrokTaskSnapshot[]): void;
  commandItemId?(taskId: string): HostItemId | undefined;
  isOpen(): boolean;
  scheduledTaskIds?: ReadonlySet<string>;
  scheduledChildIds?: ReadonlySet<string>;
}): HarnessBackgroundActivityCapability {
  let tasks: GrokTaskSnapshot[] = [];
  const classifiedChildIds = new Set<string>();
  const listedChildren = (): HostSubagentState[] => {
    const keep = new Set<string>();
    for (const loop of options.loops.values()) {
      if (loop.lastSubagentId) keep.add(loop.lastSubagentId);
    }
    const active: HostSubagentState[] = [];
    const settled: HostSubagentState[] = [];
    for (const child of options.children.values()) {
      if (!child.nativeSubagentId) continue;
      if (isActiveChild(child.status)) active.push(child);
      else settled.push(child);
    }
    const newestSettled = settled.reverse();
    for (const child of newestSettled.slice(0, SETTLED_SUBAGENT_ACTIVITY_LIMIT)) {
      if (child.nativeSubagentId) keep.add(child.nativeSubagentId);
    }
    return [
      ...active,
      ...newestSettled.filter(
        (child) => child.nativeSubagentId && keep.has(child.nativeSubagentId),
      ),
    ];
  };
  const summaries = (): BackgroundActivity[] => [
    ...tasks.map((task): BackgroundActivity => {
      const commandItemId = options.commandItemId?.(task.task_id);
      return {
        id: `task:${task.task_id}`,
        kind: task.kind === "monitor" ? "monitor" : "task",
        label: task.description ?? task.command,
        status: !task.completed
          ? "running"
          : task.explicitly_killed
            ? "cancelled"
            : task.exit_code === 0
              ? "completed"
              : task.exit_code != null || task.signal
                ? "failed"
                : "unknown",
        canStop: !task.completed && Boolean(options.killTask),
        ...(commandItemId ? { commandItemId } : {}),
      };
    }),
    ...[...options.loops.values()].map((loop): BackgroundActivity => ({
      id: `loop:${loop.taskId}`,
      kind: "loop",
      label: loop.prompt,
      status: "scheduled",
      canStop: Boolean(options.deleteLoop),
      schedule: loop.humanSchedule,
      ...(loop.nextFireAt ? { nextRunAt: loop.nextFireAt } : {}),
      ...(loop.lastSubagentId ? { relatedActivityId: `subagent:${loop.lastSubagentId}` } : {}),
    })),
    ...listedChildren().map((child): BackgroundActivity => ({
      id: `subagent:${child.nativeSubagentId}`,
      kind: "subagent",
      label: child.description,
      status:
        child.status === "pending" || child.status === "running"
          ? "running"
          : child.status === "interrupted"
            ? "cancelled"
            : child.status,
      canStop: false,
    })),
  ];
  const capability: HarnessBackgroundActivityCapability = {
    subagents: () =>
      [...options.children.values()].map((state) => ({
        activityId: `subagent:${state.nativeSubagentId}`,
        state,
      })),
    async list() {
      if (!options.isOpen()) return fail("nativeFailure", "Grok Session is closed");
      try {
        const loops = await readGrokScheduledLoops(options.directory);
        if (!options.isOpen()) return fail("nativeFailure", "Grok Session changed");
        // Live event identities, including deletions, take precedence over restoration.
        if (loops) {
          for (const id of options.loops.keys())
            if (!options.observedLoopIds.has(id) && !loops.has(id)) options.loops.delete(id);
          for (const [id, loop] of loops)
            if (!options.observedLoopIds.has(id)) options.loops.set(id, loop);
        }
        for (const loop of options.loops.values()) {
          if (loop.lastSubagentId && !options.children.has(loop.lastSubagentId))
            options.children.set(loop.lastSubagentId, {
              subagentId: loop.lastSubagentId,
              nativeSubagentId: loop.lastSubagentId,
              description: loop.prompt,
              background: true,
              status: "pending",
            });
        }
        if (options.listTasks) {
          const nativeTasks = parseGrokTaskList(await options.listTasks(), options.sessionId);
          if (!options.isOpen()) return fail("nativeFailure", "Grok Session changed");
          tasks = nativeTasks;
          options.observeTasks?.(tasks);
        }
        if (options.getChild)
          for (const [id, child] of options.children) {
            if (child.status !== "running" && child.status !== "pending") continue;
            const raw = await options.getChild(id);
            if (!options.isOpen()) return fail("nativeFailure", "Grok Session changed");
            if (!record(raw)) throw new Error("Malformed native child response");
            const snapshot = raw.snapshot;
            if (snapshot === null) continue;
            if (
              !record(snapshot) ||
              snapshot.subagentId !== id ||
              snapshot.parentSessionId !== options.sessionId
            )
              throw new Error("Native child owner mismatch");
            const status = snapshot.status;
            if (
              !["initializing", "running", "completed", "failed", "cancelled"].includes(
                String(status),
              )
            )
              throw new Error("Unknown native child status");
            options.children.set(id, {
              ...child,
              status:
                status === "initializing"
                  ? "pending"
                  : status === "cancelled"
                    ? "interrupted"
                    : (status as "running" | "completed" | "failed"),
            });
          }
        await tagGrokScheduledActivityChildren({
          directory: options.directory,
          children: options.children,
          attempted: classifiedChildIds,
          ...(options.scheduledTaskIds ? { scheduledTaskIds: options.scheduledTaskIds } : {}),
          ...(options.scheduledChildIds ? { scheduledChildIds: options.scheduledChildIds } : {}),
        });
        if (!options.isOpen()) return fail("nativeFailure", "Grok Session changed");
        return { ok: true, value: summaries() };
      } catch (error) {
        return fail(
          "nativeFailure",
          error instanceof Error ? error.message : "Grok activity read failed",
        );
      }
    },
    async read(id): Promise<HarnessResult<BackgroundActivityDetail>> {
      const listed = await capability.list();
      if (!listed.ok) return listed;
      const activity = listed.value.find((entry) => entry.id === id);
      if (!activity) return fail("invalidRequest", "Native background activity was not found");
      let output = "";
      let truncated = false;
      if (activity.kind === "task" || activity.kind === "monitor") {
        const task = tasks.find((entry) => `task:${entry.task_id}` === id);
        output = task?.output ?? "";
        truncated = task?.truncated ?? false;
      } else if (activity.kind === "loop") {
        output = activity.label;
      } else {
        const snapshot = await options.readChild(id.slice("subagent:".length));
        if (!snapshot.ok) return snapshot;
        output = snapshot.value.turns
          .flatMap((turn) =>
            turn.items.flatMap(({ item }) => {
              if (item.type === "agentMessage" || item.type === "reasoning") return [item.text];
              if (item.type === "commandExecution")
                return [`$ ${item.command}\n${item.output ?? ""}`];
              return [];
            }),
          )
          .join("\n\n");
      }
      if (output.length > options.outputLimit) {
        output = output.slice(0, options.outputLimit);
        truncated = true;
      }
      return { ok: true, value: { activity, output, truncated } };
    },
    async stop(id): Promise<HarnessResult<BackgroundActivityStopResult>> {
      const listed = await capability.list();
      if (!listed.ok) return listed;
      const activity = listed.value.find((entry) => entry.id === id);
      if (!activity) return { ok: true, value: { outcome: "notFound" } };
      if (!activity.canStop)
        return fail("unsupported", "Native activity cannot be stopped through this interface");
      try {
        if (activity.kind === "loop" && options.deleteLoop) {
          const deleted = await options.deleteLoop(id.slice("loop:".length));
          const nativeId = id.slice("loop:".length);
          options.observedLoopIds.add(nativeId);
          options.loops.delete(nativeId);
          return { ok: true, value: { outcome: deleted ? "stopped" : "notFound" } };
        }
        if (options.killTask) {
          const result = await options.killTask(id.slice("task:".length));
          return {
            ok: true,
            value: {
              outcome:
                result === "killed"
                  ? "stopped"
                  : result === "already_exited"
                    ? "alreadyStopped"
                    : "notFound",
            },
          };
        }
        return fail("unsupported", "Native stop is unavailable");
      } catch (error) {
        return fail(
          "nativeFailure",
          error instanceof Error ? error.message : "Grok activity stop failed",
        );
      }
    },
  };
  return capability;
}
