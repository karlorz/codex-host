import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSubagentState } from "@codexhost/harness-adapter";
import { hostItemIdSchema, type HostItemId } from "@codexhost/shared-contracts";
import {
  createGrokActivity,
  parseGrokTaskList,
  readGrokScheduledLoops,
} from "../src/grok-activity.js";
import { applyGrokScheduledEvent, type GrokScheduledLoop } from "../src/grok-background.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-activity-"));
  roots.push(directory);
  const loops = new Map<string, GrokScheduledLoop>();
  const observedLoopIds = new Set<string>();
  const nativeEvent = (event: Parameters<typeof applyGrokScheduledEvent>[1]) =>
    applyGrokScheduledEvent(loops, event, observedLoopIds);
  const children = new Map<string, HostSubagentState>();
  const tasks = [
    {
      task_id: "r",
      command: "printf hello",
      output: "hello",
      truncated: false,
      completed: false,
      is_backgrounded: true,
      owner_session_id: "parent",
      kind: "bash",
    },
  ];
  const killTask = vi.fn(async () => "killed" as const);
  const deleteLoop = vi.fn(async () => true);
  const readChild = vi.fn(async () => ({ ok: true as const, value: { turns: [] } }));
  let open = true;
  const commandItems = new Map<string, HostItemId>();
  const activity = createGrokActivity({
    sessionId: "parent",
    directory,
    loops,
    observedLoopIds,
    children,
    listTasks: async () => ({ tasks }),
    killTask,
    deleteLoop,
    readChild,
    outputLimit: 100,
    commandItemId: (id) => commandItems.get(id),
    isOpen: () => open,
  });
  return {
    directory,
    loops,
    nativeEvent,
    children,
    tasks,
    killTask,
    deleteLoop,
    readChild,
    activity,
    commandItems,
    close: () => {
      open = false;
    },
  };
}
describe("Grok native background activity", () => {
  it("identifies only commands with known detached Desktop Items, including retained history", async () => {
    const s = await setup();
    const restored = await s.activity.read("task:r");
    expect(restored.ok && restored.value.activity.commandItemId).toBeUndefined();
    s.commandItems.set("r", hostItemIdSchema.parse("detached-command"));
    expect(await s.activity.read("task:r")).toMatchObject({
      ok: true,
      value: { activity: { commandItemId: "detached-command", status: "running" } },
    });
    for (const task of s.tasks) task.completed = true;
    expect(await s.activity.read("task:r")).toMatchObject({
      ok: true,
      value: { activity: { commandItemId: "detached-command" } },
    });
  });
  it("scopes process ownership and refuses malformed lists", () => {
    const task = {
      task_id: "t",
      command: "x",
      output: "",
      truncated: false,
      completed: false,
      is_backgrounded: true,
    };
    expect(
      parseGrokTaskList(
        {
          tasks: [
            task,
            { ...task, task_id: "foreign", owner_session_id: "child" },
            { ...task, task_id: "foreground", is_backgrounded: false },
          ],
        },
        "parent",
      ),
    ).toEqual([task]);
    expect(() => parseGrokTaskList({}, "parent")).toThrow("Malformed");
    expect(() => parseGrokTaskList({ tasks: [{}] }, "parent")).toThrow("Malformed");
  });
  it("reads native persisted cadence and replaces a deleted registry", async () => {
    const s = await setup();
    await writeFile(
      path.join(s.directory, "resources_state.json"),
      JSON.stringify({
        state: {
          "grok_build.Scheduler": {
            tasks: [
              {
                id: "l",
                prompt: "check",
                intervalSecs: 60,
                createdAt: "2026-11-01T00:00:00Z",
                lastFiredAt: "2026-11-01T00:01:00Z",
                lastSubagentId: "child",
              },
            ],
          },
        },
      }),
    );
    expect((await readGrokScheduledLoops(s.directory))?.get("l")).toMatchObject({
      nextFireAt: "2026-11-01T00:02:00.000Z",
      lastSubagentId: "child",
    });
    expect(await s.activity.list()).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        {
          id: "loop:l",
          kind: "loop",
          label: "check",
          status: "scheduled",
          canStop: true,
          schedule: "every 60 seconds",
          nextRunAt: "2026-11-01T00:02:00.000Z",
          relatedActivityId: "subagent:child",
        },
      ]),
    });
    await writeFile(path.join(s.directory, "resources_state.json"), JSON.stringify({ state: {} }));
    await s.activity.list();
    expect(s.loops.size).toBe(0);
  });
  it("reads actual process output and uses native stop outcomes", async () => {
    const s = await setup();
    expect(await s.activity.read("task:r")).toMatchObject({
      ok: true,
      value: { output: "hello", truncated: false, activity: { kind: "task", status: "running" } },
    });
    expect(await s.activity.stop("task:r")).toEqual({ ok: true, value: { outcome: "stopped" } });
    expect(s.killTask).toHaveBeenCalledWith("r");
    expect(await s.activity.stop("task:foreign")).toEqual({
      ok: true,
      value: { outcome: "notFound" },
    });
    expect(s.killTask).toHaveBeenCalledTimes(1);
  });
  it("preserves a native Loop creation received during a persisted-state read", async () => {
    const s = await setup();
    await writeFile(path.join(s.directory, "resources_state.json"), JSON.stringify({ state: {} }));
    const pending = s.activity.list();
    s.nativeEvent({
      type: "scheduled.created",
      taskId: "new",
      prompt: "new native schedule",
      humanSchedule: "every minute",
    });
    expect(await pending).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ id: "loop:new", status: "scheduled" }),
      ]),
    });
  });
  it("keeps a live Loop across repeated polls while scheduler persistence lags", async () => {
    const s = await setup();
    await writeFile(path.join(s.directory, "resources_state.json"), JSON.stringify({ state: {} }));
    s.nativeEvent({
      type: "scheduled.created",
      taskId: "live",
      prompt: "live native schedule",
      humanSchedule: "every minute",
    });
    for (let poll = 0; poll < 3; poll++)
      expect(await s.activity.list()).toMatchObject({
        ok: true,
        value: expect.arrayContaining([expect.objectContaining({ id: "loop:live" })]),
      });
  });
  it("does not restore a native Loop deleted during a persisted-state read", async () => {
    const s = await setup();
    s.loops.set("deleted", {
      taskId: "deleted",
      prompt: "deleted native schedule",
      humanSchedule: "every minute",
    });
    await writeFile(
      path.join(s.directory, "resources_state.json"),
      JSON.stringify({
        state: {
          "grok_build.Scheduler": {
            tasks: [{ id: "deleted", prompt: "deleted native schedule", intervalSecs: 60 }],
          },
        },
      }),
    );
    const pending = s.activity.list();
    s.nativeEvent({ type: "scheduled.deleted", taskId: "deleted" });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.some((item) => item.kind === "loop")).toBe(false);
    for (let poll = 0; poll < 2; poll++) {
      const next = await s.activity.list();
      expect(next.ok && next.value.some((item) => item.kind === "loop")).toBe(false);
    }
  });
  it("preserves an updated native Loop when registry size stays unchanged during a read", async () => {
    const s = await setup();
    await writeFile(path.join(s.directory, "resources_state.json"), JSON.stringify({ state: {} }));
    const loop = { taskId: "l", prompt: "check", humanSchedule: "every minute" };
    s.loops.set("l", loop);
    const pending = s.activity.list();
    s.nativeEvent({ type: "scheduled.fired", ...loop, subagentId: "latest" });
    expect(await pending).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ id: "loop:l", relatedActivityId: "subagent:latest" }),
      ]),
    });
  });
  it("keeps native schedule identity through concurrent polling and two fire intervals", async () => {
    const s = await setup();
    const file = path.join(s.directory, "resources_state.json");
    await writeFile(file, JSON.stringify({ state: {} }));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
      const loop = { taskId: "live", prompt: "check", humanSchedule: "every two minutes" };
      s.nativeEvent({ type: "scheduled.created", ...loop });
      for (let second = 1; second <= 240; second++) {
        await vi.advanceTimersByTimeAsync(1000);
        if (second % 120 === 0)
          s.nativeEvent({
            type: "scheduled.fired",
            ...loop,
            subagentId: `child-${second}`,
            nextFireAt: new Date(Date.now() + 120000).toISOString(),
          });
        for (const result of await Promise.all([s.activity.list(), s.activity.list()])) {
          expect(result.ok).toBe(true);
          if (result.ok)
            expect(result.value.filter((item) => item.kind === "loop")).toEqual([
              expect.objectContaining({
                id: "loop:live",
                status: "scheduled",
                ...(second >= 120
                  ? { relatedActivityId: `subagent:child-${second < 240 ? 120 : 240}` }
                  : {}),
              }),
            ]);
        }
      }
      await writeFile(
        file,
        JSON.stringify({
          state: {
            "grok_build.Scheduler": {
              tasks: [{ id: "live", prompt: "check", intervalSecs: 120 }],
            },
          },
        }),
      );
      s.nativeEvent({ type: "scheduled.deleted", taskId: "live" });
      for (const result of await Promise.all([s.activity.list(), s.activity.list()]))
        expect(result.ok && result.value.some((item) => item.kind === "loop")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a Loop separate from its real child and never stops unrelated children", async () => {
    const s = await setup();
    s.loops.set("l", {
      taskId: "l",
      prompt: "check",
      humanSchedule: "every minute",
      lastSubagentId: "c",
    });
    s.children.set("c", {
      subagentId: "c",
      nativeSubagentId: "c",
      description: "check run",
      background: true,
      status: "completed",
    });
    expect(await s.activity.read("subagent:c")).toMatchObject({
      ok: true,
      value: { output: "", activity: { status: "completed" } },
    });
    expect(s.readChild).toHaveBeenCalledWith("c");
    expect(await s.activity.stop("subagent:c")).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(await s.activity.stop("loop:l")).toEqual({ ok: true, value: { outcome: "stopped" } });
    expect(s.deleteLoop).toHaveBeenCalledWith("l");
    expect(s.killTask).not.toHaveBeenCalled();
    expect(s.children.has("c")).toBe(true);
  });
  it("does not restore a persisted schedule after native deletion reports it absent", async () => {
    const s = await setup();
    await writeFile(
      path.join(s.directory, "resources_state.json"),
      JSON.stringify({
        state: {
          "grok_build.Scheduler": {
            tasks: [{ id: "gone", prompt: "check", intervalSecs: 60 }],
          },
        },
      }),
    );
    s.deleteLoop.mockResolvedValueOnce(false);
    expect(await s.activity.stop("loop:gone")).toEqual({
      ok: true,
      value: { outcome: "notFound" },
    });
    const next = await s.activity.list();
    expect(next.ok && next.value.some((item) => item.kind === "loop")).toBe(false);
    expect(s.killTask).not.toHaveBeenCalled();
  });
  it("reports native read errors and closed Sessions explicitly", async () => {
    const s = await setup();
    await writeFile(path.join(s.directory, "resources_state.json"), "broken");
    expect(await s.activity.list()).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    s.close();
    expect(await s.activity.stop("task:r")).toMatchObject({ ok: false });
  });
});
