import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  THREAD_ACTIVITY_LIST_METHOD,
  THREAD_ACTIVITY_READ_METHOD,
  THREAD_ACTIVITY_STOP_METHOD,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  messageParams,
  readJsonLine,
  requestId,
  requiredMessageId,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

it("discovers an idle Loop child in the native summary without a parent Turn", async () => {
  const fixture = createFixture();
  try {
    const parentId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("missing Session");
    const activity = {
      id: "child:loop-native-child",
      kind: "subagent",
      label: "Loop invocation",
      status: "running",
      canStop: false,
    };
    const child = {
      subagentId: "loop-native-child",
      nativeSubagentId: "loop-native-child",
      description: "Loop invocation",
      background: true,
      status: "running",
    };
    Object.assign(session, {
      backgroundActivity: {
        list: async () => ({ ok: true, value: [activity] }),
        subagents: () => [{ activityId: activity.id, state: child }],
      },
    });
    for (const id of [30, 31]) {
      writeRequest(fixture.desktopInput, {
        id,
        method: THREAD_ACTIVITY_LIST_METHOD,
        params: { threadId: parentId },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, id));
      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({
        supported: true,
        activities: [{ ...activity, threadId: expect.any(String) }],
      });
    }
    const childStarts = fixture.collector.messages.filter(
      (message) =>
        message.method === "thread/started" &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === parentId,
    );
    expect(childStarts).toHaveLength(1);
    const childThread = messageParams(childStarts[0] as JsonObject).thread as JsonObject;
    const childId = childThread.id;
    expect(childId).not.toBe(child.nativeSubagentId);
    expect(childThread).toMatchObject({
      parentThreadId: parentId,
      source: { subAgent: { thread_spawn: { agent_path: "Loop invocation" } } },
      turns: [],
    });

    const list = async (id: number) => {
      writeRequest(fixture.desktopInput, {
        id,
        method: "thread/list",
        params: {
          ancestorThreadId: parentId,
          sourceKinds: ["subAgentThreadSpawn"],
          useStateDbOnly: true,
          limit: 100,
        },
      });
      const official = await readJsonLine(fixture.official.stdin);
      expect(official.method).toBe("thread/list");
      writeRequest(fixture.official.stdout, {
        id: requiredMessageId(official),
        result: { data: [], nextCursor: null },
      });
      return fixture.collector.waitFor((message) => requestId(message, id));
    };
    expect(await list(32)).toMatchObject({
      result: {
        data: [{ id: childId, parentThreadId: parentId, status: { type: "active" } }],
      },
    });
    session.emitSubagentState(child.nativeSubagentId, "completed");
    await fixture.collector.waitFor(
      (message) =>
        message.method === "thread/status/changed" &&
        messageParams(message).threadId === childId &&
        (messageParams(message).status as JsonObject | undefined)?.type === "idle",
    );
    expect(await list(33)).toMatchObject({
      result: { data: [{ id: childId, status: { type: "idle" } }] },
    });
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(
      fixture.collector.messages.filter((message) => message.method === "turn/started"),
    ).toEqual([]);
  } finally {
    await stopFixture(fixture);
  }
});

it("routes optional activity controls independently of a running parent Turn", async () => {
  const fixture = createFixture();
  try {
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("missing Session");
    const activity = {
      id: "loop:native",
      kind: "loop",
      label: "Native watch",
      status: "scheduled",
      canStop: true,
      schedule: "every minute",
      nextRunAt: "2026-11-01T00:00:00Z",
    };
    const stop = vi.fn(async () => ({ ok: true, value: { outcome: "stopped" } }));
    Object.assign(session, {
      backgroundActivity: {
        list: async () => ({ ok: true, value: [activity] }),
        read: async () => ({
          ok: true,
          value: { activity, output: "native prompt", truncated: false },
        }),
        stop,
      },
    });
    const turnId = await startPiTurn(fixture, threadId, 2);
    for (const [id, method] of [
      [10, THREAD_ACTIVITY_LIST_METHOD],
      [11, THREAD_ACTIVITY_READ_METHOD],
      [12, THREAD_ACTIVITY_STOP_METHOD],
    ] as const) {
      writeRequest(fixture.desktopInput, {
        id,
        method,
        params: { threadId, ...(id === 10 ? {} : { activityId: "loop:native" }) },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, id));
      expect(response.error).toBeUndefined();
      if (id === 10)
        expect(response.result).toMatchObject({ supported: true, activities: [activity] });
      if (id === 11) expect(response.result).toMatchObject({ output: "native prompt" });
      if (id === 12) expect(response.result).toEqual({ outcome: "stopped" });
    }
    expect(stop).toHaveBeenCalledWith("loop:native");
    session.appendText("parent still running");
    session.succeedTurn();
    expect(turnId).toBeTruthy();
  } finally {
    await stopFixture(fixture);
  }
});

it("keeps old-plugin activity unsupported and rejects malformed requests", async () => {
  const fixture = createFixture();
  try {
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 20,
      method: THREAD_ACTIVITY_LIST_METHOD,
      params: { threadId },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 20));
    expect(response.result).toEqual({ supported: false, activities: [] });
    writeRequest(fixture.desktopInput, {
      id: 21,
      method: THREAD_ACTIVITY_STOP_METHOD,
      params: { threadId, activityId: "foreign" },
    });
    expect(
      (await fixture.collector.waitFor((message) => requestId(message, 21))).error,
    ).toMatchObject({ code: -32076 });
    writeRequest(fixture.desktopInput, { id: 22, method: THREAD_ACTIVITY_LIST_METHOD, params: {} });
    expect(
      (await fixture.collector.waitFor((message) => requestId(message, 22))).error,
    ).toMatchObject({ code: -32602 });
  } finally {
    await stopFixture(fixture);
  }
});
