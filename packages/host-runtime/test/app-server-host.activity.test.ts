import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  THREAD_ACTIVITY_LIST_METHOD,
  THREAD_ACTIVITY_READ_METHOD,
  THREAD_ACTIVITY_STOP_METHOD,
} from "@codexhost/shared-contracts";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
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

function childStartsFor(fixture: ReturnType<typeof createFixture>, parentId: string) {
  return fixture.collector.messages.filter(
    (message) =>
      message.method === "thread/started" &&
      (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === parentId,
  );
}

it("lists many settled children without creating, scanning, or announcing them", async () => {
  const fixture = createFixture();
  try {
    const parentId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("missing Session");
    const activities = Array.from({ length: 30 }, (_, index) => ({
      id: `subagent:settled-${index}`,
      kind: "subagent" as const,
      label: `settled-${index}`,
      status: "completed" as const,
      canStop: false,
    }));
    Object.assign(session, {
      backgroundActivity: {
        list: async () => ({ ok: true, value: activities }),
        read: async (id: string) => ({
          ok: true,
          value: {
            activity: activities.find((entry) => entry.id === id) ?? activities[0],
            output: "native result",
            truncated: false,
          },
        }),
        subagents: () =>
          activities.map((activity, index) => ({
            activityId: activity.id,
            state: {
              subagentId: `settled-${index}`,
              nativeSubagentId: `settled-${index}`,
              description: `settled-${index}`,
              background: true,
              status: "completed" as const,
            },
          })),
      },
    });
    const started = childStartsFor(fixture, parentId).length;
    const listThreads = vi.spyOn(fixture.mappingStore, "listThreads");
    const createProvisional = vi.spyOn(fixture.mappingStore, "createProvisional");
    writeRequest(fixture.desktopInput, {
      id: 40,
      method: THREAD_ACTIVITY_LIST_METHOD,
      params: { threadId: parentId },
    });
    const listed = await fixture.collector.waitFor((message) => requestId(message, 40));
    expect(listed.error).toBeUndefined();
    expect(
      (listed.result as { activities: { id: string; threadId?: string }[] }).activities.every(
        (activity) => activity.threadId === undefined,
      ),
    ).toBe(true);
    expect(childStartsFor(fixture, parentId)).toHaveLength(started);
    expect(createProvisional).not.toHaveBeenCalled();
    expect(listThreads).not.toHaveBeenCalled();

    writeRequest(fixture.desktopInput, {
      id: 41,
      method: THREAD_ACTIVITY_READ_METHOD,
      params: { threadId: parentId, activityId: "subagent:settled-7" },
    });
    const read = await fixture.collector.waitFor((message) => requestId(message, 41));
    expect(read.result).toMatchObject({
      activity: { id: "subagent:settled-7", threadId: expect.any(String) },
      output: "native result",
    });
    const announced = childStartsFor(fixture, parentId);
    expect(announced).toHaveLength(started + 1);
    expect((messageParams(announced.at(-1) as JsonObject).thread as JsonObject).id).toBe(
      (read.result as { activity: { threadId: string } }).activity.threadId,
    );
    expect(createProvisional).toHaveBeenCalledTimes(1);
  } finally {
    await stopFixture(fixture);
  }
});

it("re-links an existing idle child silently and still announces an active child", async () => {
  const fixture = createFixture();
  try {
    const parentId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("missing Session");
    const idle = {
      id: "subagent:idle-child",
      kind: "subagent" as const,
      label: "Idle run",
      status: "completed" as const,
      canStop: false,
    };
    const running = {
      id: "subagent:live-child",
      kind: "subagent" as const,
      label: "Live run",
      status: "running" as const,
      canStop: false,
    };
    const idleState = {
      subagentId: "idle-child",
      nativeSubagentId: "idle-child",
      description: "Idle run",
      background: true,
      status: "completed" as const,
    };
    const runningState = {
      subagentId: "live-child",
      nativeSubagentId: "live-child",
      description: "Live run",
      background: true,
      status: "running" as const,
    };
    const repository = new ExternalThreadRepository(fixture.mappingStore);
    const parent = await repository.find(parentId);
    if (!parent) throw new Error("missing parent");
    const existing = await repository.materializeSubagent(parent, idleState);
    if (!existing) throw new Error("missing child");
    Object.assign(session, {
      backgroundActivity: {
        list: async () => ({ ok: true, value: [idle, running] }),
        read: async () => ({
          ok: true,
          value: { activity: idle, output: "native result", truncated: false },
        }),
        subagents: () => [
          { activityId: idle.id, state: idleState },
          { activityId: running.id, state: runningState },
        ],
      },
    });
    const started = childStartsFor(fixture, parentId).length;
    const listThreads = vi.spyOn(fixture.mappingStore, "listThreads");
    const createProvisional = vi.spyOn(fixture.mappingStore, "createProvisional");
    writeRequest(fixture.desktopInput, {
      id: 50,
      method: THREAD_ACTIVITY_LIST_METHOD,
      params: { threadId: parentId },
    });
    const listed = await fixture.collector.waitFor((message) => requestId(message, 50));
    expect(listed.result).toMatchObject({
      activities: [
        { id: idle.id, threadId: existing.hostThreadId },
        { id: running.id, threadId: expect.any(String) },
      ],
    });
    const announced = childStartsFor(fixture, parentId);
    expect(announced).toHaveLength(started + 1);
    expect((messageParams(announced.at(-1) as JsonObject).thread as JsonObject).id).toBe(
      (listed.result as { activities: { threadId: string }[] }).activities[1]?.threadId,
    );
    expect(
      (listed.result as { activities: { threadId: string }[] }).activities[1]?.threadId,
    ).not.toBe(existing.hostThreadId);
    expect(createProvisional).toHaveBeenCalledTimes(1);
    const scansAfterList = listThreads.mock.calls.length;

    writeRequest(fixture.desktopInput, {
      id: 51,
      method: THREAD_ACTIVITY_READ_METHOD,
      params: { threadId: parentId, activityId: idle.id },
    });
    const read = await fixture.collector.waitFor((message) => requestId(message, 51));
    expect(read.result).toMatchObject({
      activity: { id: idle.id, threadId: existing.hostThreadId },
    });
    expect(childStartsFor(fixture, parentId)).toHaveLength(started + 1);
    expect(listThreads).toHaveBeenCalledTimes(scansAfterList);
    expect(createProvisional).toHaveBeenCalledTimes(1);

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
    const liveId = (listed.result as { activities: { threadId: string }[] }).activities[1]
      ?.threadId;
    expect(await list(52)).toMatchObject({
      result: {
        data: expect.arrayContaining([
          expect.objectContaining({
            id: existing.hostThreadId,
            parentThreadId: parentId,
            status: { type: "idle" },
          }),
          expect.objectContaining({
            id: liveId,
            parentThreadId: parentId,
            status: { type: "active", activeFlags: [] },
          }),
        ]),
      },
    });
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

it("backfills scheduled origin once and does not write on the next poll", async () => {
  const fixture = createFixture();
  try {
    const parentId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("missing Session");
    const idleState = {
      subagentId: "legacy-loop",
      nativeSubagentId: "legacy-loop",
      description: "Legacy loop",
      background: true,
      status: "completed" as const,
    };
    const repository = new ExternalThreadRepository(fixture.mappingStore);
    const parent = await repository.find(parentId);
    if (!parent) throw new Error("missing parent");
    const existing = await repository.materializeSubagent(parent, idleState);
    if (!existing) throw new Error("missing child");
    expect(existing.subagent).not.toHaveProperty("origin");
    Object.assign(session, {
      backgroundActivity: {
        list: async () => ({
          ok: true,
          value: [
            {
              id: "subagent:legacy-loop",
              kind: "subagent",
              label: "Legacy loop",
              status: "completed",
              canStop: false,
            },
          ],
        }),
        subagents: () => [
          {
            activityId: "subagent:legacy-loop",
            state: { ...idleState, origin: "scheduled" as const },
          },
        ],
      },
    });
    const setOrigin = vi.spyOn(fixture.mappingStore, "setSubagentOrigin");
    for (const id of [60, 61]) {
      writeRequest(fixture.desktopInput, {
        id,
        method: THREAD_ACTIVITY_LIST_METHOD,
        params: { threadId: parentId },
      });
      expect(
        (await fixture.collector.waitFor((message) => requestId(message, id))).error,
      ).toBeUndefined();
    }
    expect(setOrigin).toHaveBeenCalledTimes(1);
    expect(await fixture.mappingStore.getThread(existing.hostThreadId)).toMatchObject({
      subagent: { origin: "scheduled", nativeSubagentId: "legacy-loop" },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("hides settled scheduled children from scoped thread/list and still reads them by id", async () => {
  const fixture = createFixture();
  try {
    const parentId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("missing Session");
    const repository = new ExternalThreadRepository(fixture.mappingStore);
    const parent = await repository.find(parentId);
    if (!parent) throw new Error("missing parent");
    const settledState = {
      subagentId: "loop-settled",
      nativeSubagentId: "loop-settled",
      description: "Settled loop",
      background: true,
      status: "completed" as const,
      origin: "scheduled" as const,
    };
    const ordinaryState = {
      subagentId: "ordinary-child",
      nativeSubagentId: "ordinary-child",
      description: "Ordinary child",
      background: true,
      status: "completed" as const,
    };
    const runningState = {
      subagentId: "loop-running",
      nativeSubagentId: "loop-running",
      description: "Running loop",
      background: true,
      status: "running" as const,
      origin: "scheduled" as const,
    };
    const settled = await repository.materializeSubagent(parent, settledState);
    const ordinary = await repository.materializeSubagent(parent, ordinaryState);
    if (!settled || !ordinary) throw new Error("missing child");
    Object.assign(session, {
      backgroundActivity: {
        list: async () => ({
          ok: true,
          value: [
            {
              id: "subagent:loop-settled",
              kind: "subagent",
              label: "Settled loop",
              status: "completed",
              canStop: false,
            },
            {
              id: "subagent:ordinary-child",
              kind: "subagent",
              label: "Ordinary child",
              status: "completed",
              canStop: false,
            },
            {
              id: "subagent:loop-running",
              kind: "subagent",
              label: "Running loop",
              status: "running",
              canStop: false,
            },
          ],
        }),
        subagents: () => [
          { activityId: "subagent:loop-settled", state: settledState },
          { activityId: "subagent:ordinary-child", state: ordinaryState },
          { activityId: "subagent:loop-running", state: runningState },
        ],
      },
    });
    writeRequest(fixture.desktopInput, {
      id: 70,
      method: THREAD_ACTIVITY_LIST_METHOD,
      params: { threadId: parentId },
    });
    const listed = await fixture.collector.waitFor((message) => requestId(message, 70));
    expect(listed.error).toBeUndefined();
    const runningId = (
      listed.result as { activities: { id: string; threadId?: string }[] }
    ).activities.find((activity) => activity.id === "subagent:loop-running")?.threadId;
    writeRequest(fixture.desktopInput, {
      id: 71,
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
    const scoped = await fixture.collector.waitFor((message) => requestId(message, 71));
    expect(scoped.result).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: ordinary.hostThreadId }),
        expect.objectContaining({
          id: runningId,
          status: { type: "active", activeFlags: [] },
        }),
      ]),
    });
    expect((scoped.result as { data: { id: string }[] }).data.map((row) => row.id)).not.toContain(
      settled.hostThreadId,
    );
    writeRequest(fixture.desktopInput, {
      id: 72,
      method: "thread/read",
      params: { threadId: settled.hostThreadId },
    });
    const read = await fixture.collector.waitFor((message) => requestId(message, 72));
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({
      thread: { id: settled.hostThreadId, parentThreadId: parentId },
    });
  } finally {
    await stopFixture(fixture);
  }
});
