import { describe, expect, it, vi } from "vitest";
import type {
  HarnessBackgroundActivityCapability,
  HarnessSession,
  HostSubagentState,
} from "@codexhost/harness-adapter";
import {
  THREAD_ACTIVITY_LIST_METHOD,
  THREAD_ACTIVITY_READ_METHOD,
  THREAD_ACTIVITY_STOP_METHOD,
  hostItemIdSchema,
} from "@codexhost/shared-contracts";
import { executeExternalActivity } from "../src/external-thread-activity.js";

const child: HostSubagentState = {
  subagentId: "native-child",
  nativeSubagentId: "native-child",
  description: "Real child",
  background: true,
  status: "completed",
};
const summary = {
  id: "subagent:native-child",
  kind: "subagent" as const,
  label: "Real child",
  status: "completed" as const,
  canStop: false,
};
function setup() {
  const capability: HarnessBackgroundActivityCapability = {
    list: vi.fn<HarnessBackgroundActivityCapability["list"]>(async () => ({
      ok: true,
      value: [summary],
    })),
    read: vi.fn<HarnessBackgroundActivityCapability["read"]>(async () => ({
      ok: true,
      value: { activity: summary, output: "native result", truncated: false },
    })),
    stop: vi.fn<HarnessBackgroundActivityCapability["stop"]>(async () => ({
      ok: true,
      value: { outcome: "stopped" },
    })),
    subagents: () => [{ activityId: summary.id, state: child }],
  };
  const session = { backgroundActivity: capability } as HarnessSession;
  const materialize = vi.fn(async (state: HostSubagentState) => ({
    ...state,
    subagentId: "host-child",
  }));
  const lookup = vi.fn(async (state: HostSubagentState): Promise<HostSubagentState | null> => ({
    ...state,
    subagentId: "host-child",
  }));
  let current = true;
  return {
    capability,
    session,
    materialize,
    lookup,
    isCurrent: () => current,
    replace: () => {
      current = false;
    },
  };
}
describe("external background activity bridge", () => {
  it("preserves native command Item identity through the browser contract", async () => {
    const s = setup();
    const task = {
      id: "task:r",
      kind: "task" as const,
      label: "Native command",
      status: "running" as const,
      canStop: true,
      commandItemId: hostItemIdSchema.parse("command-r"),
    };
    s.capability.list = async () => ({ ok: true, value: [task] });
    s.capability.read = async () => ({
      ok: true,
      value: { activity: task, output: "live", truncated: false },
    });
    expect(
      await executeExternalActivity({ ...s, method: THREAD_ACTIVITY_LIST_METHOD }),
    ).toMatchObject({ result: { activities: [task] } });
    expect(
      await executeExternalActivity({
        ...s,
        method: THREAD_ACTIVITY_READ_METHOD,
        activityId: task.id,
      }),
    ).toMatchObject({ result: { activity: task } });
  });
  it("keeps old plugins explicitly unsupported", async () => {
    const s = setup();
    const session = {} as HarnessSession;
    expect(
      await executeExternalActivity({ ...s, session, method: THREAD_ACTIVITY_LIST_METHOD }),
    ).toEqual({ result: { supported: false, activities: [] } });
    expect(
      await executeExternalActivity({
        ...s,
        session,
        method: THREAD_ACTIVITY_STOP_METHOD,
        activityId: "x",
      }),
    ).toMatchObject({ error: { code: -32076 } });
  });
  it("lists settled children through lookup without creating, and materializes on read", async () => {
    const s = setup();
    expect(
      await executeExternalActivity({ ...s, method: THREAD_ACTIVITY_LIST_METHOD }),
    ).toMatchObject({
      result: { supported: true, activities: [{ ...summary, threadId: "host-child" }] },
    });
    expect(s.materialize).not.toHaveBeenCalled();
    expect(s.lookup).toHaveBeenCalledWith(child);
    expect(
      await executeExternalActivity({
        ...s,
        method: THREAD_ACTIVITY_READ_METHOD,
        activityId: summary.id,
      }),
    ).toMatchObject({ result: { activity: { threadId: "host-child" }, output: "native result" } });
    expect(s.materialize).toHaveBeenCalledTimes(1);
    expect(s.materialize).toHaveBeenCalledWith(child);
  });
  it("runs afterList after a successful list and before materializing running children", async () => {
    const s = setup();
    const order: string[] = [];
    const running = { ...child, status: "running" as const };
    s.capability.subagents = () => [{ activityId: summary.id, state: running }];
    s.capability.list = async () => {
      order.push("list");
      return { ok: true, value: [{ ...summary, status: "running" as const }] };
    };
    s.materialize.mockImplementation(async (state) => {
      order.push("materialize");
      return { ...state, subagentId: "host-child" };
    });
    await executeExternalActivity({
      ...s,
      method: THREAD_ACTIVITY_LIST_METHOD,
      afterList: async () => {
        order.push("afterList");
      },
    });
    expect(order).toEqual(["list", "afterList", "materialize"]);
  });
  it("lists running children by materializing them", async () => {
    const s = setup();
    const running = { ...child, status: "running" as const };
    s.capability.subagents = () => [{ activityId: summary.id, state: running }];
    s.capability.list = async () => ({
      ok: true,
      value: [{ ...summary, status: "running" as const }],
    });
    expect(
      await executeExternalActivity({ ...s, method: THREAD_ACTIVITY_LIST_METHOD }),
    ).toMatchObject({
      result: { activities: [{ threadId: "host-child", status: "running" }] },
    });
    expect(s.materialize).toHaveBeenCalledWith(running);
    expect(s.lookup).not.toHaveBeenCalled();
  });
  it("lists settled children without a threadId when lookup misses", async () => {
    const s = setup();
    s.lookup.mockResolvedValue(null);
    expect(
      await executeExternalActivity({ ...s, method: THREAD_ACTIVITY_LIST_METHOD }),
    ).toMatchObject({
      result: { activities: [summary] },
    });
    expect(s.materialize).not.toHaveBeenCalled();
  });
  it("drops results after replacement and does not mutate a replacement Session", async () => {
    const s = setup();
    s.capability.list = async () => {
      s.replace();
      return { ok: true, value: [summary] };
    };
    expect(
      await executeExternalActivity({ ...s, method: THREAD_ACTIVITY_LIST_METHOD }),
    ).toMatchObject({ error: { code: -32083 } });
    expect(s.materialize).not.toHaveBeenCalled();
    expect(
      await executeExternalActivity({ ...s, method: THREAD_ACTIVITY_STOP_METHOD, activityId: "x" }),
    ).toMatchObject({ error: { code: -32083 } });
    expect(s.capability.stop).not.toHaveBeenCalled();
  });
  it("returns explicit native control errors", async () => {
    const s = setup();
    s.capability.stop = async () => ({
      ok: false,
      error: { code: "unsupported", message: "Native API unavailable", retryable: false },
    });
    expect(
      await executeExternalActivity({ ...s, method: THREAD_ACTIVITY_STOP_METHOD, activityId: "x" }),
    ).toEqual({ error: { code: -32076, message: "Native API unavailable" } });
  });
});
