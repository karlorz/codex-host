import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  GrokAdapter,
  grokNativeSessionDirectory,
  type GrokAcpTransportLike,
  type GrokTransportEvent,
} from "@codexhost/adapter-grok";
import { MappingStore } from "@codexhost/mapping-store";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { AppServerHost } from "../src/app-server-host.js";
import {
  FakeOfficialProcess,
  JsonLineCollector,
  requestId,
  writeRequest,
} from "./app-server-host-fixture.js";

it("projects a real Grok goal worker through the Host after Desktop's ephemeral opening command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-host-goal-"));
  const cwd = path.join(root, "project");
  const environment = {
    HOME: root,
    GROK_HOME: path.join(root, "grok"),
    CODEXHOST_DATA_DIR: path.join(root, "host"),
  };
  await mkdir(cwd);
  const sessionId = "native-goal-session";
  const directory = grokNativeSessionDirectory({ cwd, environment }, sessionId);
  const history: GrokTransportEvent[] = [];
  let observer: Parameters<NonNullable<GrokAcpTransportLike["observeBackground"]>>[0] | undefined;
  const initialize = {
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [],
    _meta: {
      modelState: {
        currentModelId: "grok-4.6",
        availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }],
      },
    },
  };
  const nativeControl = vi.fn(async (prompt: string) => {
    if (prompt === "/goal clear") {
      await rm(path.join(directory, "goal/state.json"));
      observer?.onEvent({ type: "goal.changed", update: null });
    } else {
      await mkdir(path.join(directory, "goal"), { recursive: true });
      const state = {
        goal_id: "native-goal",
        objective: "smoke",
        status: "active",
        token_budget: null,
        tokens_used_high_water: 0,
        elapsed_ms: 0,
        created_at: new Date().toISOString(),
      };
      await writeFile(path.join(directory, "goal/state.json"), JSON.stringify(state));
      observer?.onEvent({ type: "goal.changed", update: { ...state, tokens_used: 0 } });
    }
    return { stopReason: "end_turn" as const };
  });
  const transport: GrokAcpTransportLike = {
    sessionId,
    inspect: async () => initialize,
    open: async () => ({ sessionId, initialize, session: { sessionId }, replay: [] }),
    getHistory: async () => [...history],
    getUsage: async () => undefined,
    readHistory: async () => [...history],
    locateSession: async () => null,
    deleteSession: async () => {},
    runTurn: async () => {
      throw new Error("Goal control must not run an ordinary prompt");
    },
    compact: async () => {
      throw new Error("Unexpected compaction");
    },
    setModel: async () => {},
    setPermissionMode: async () => {},
    cancel: async () => {},
    close: async () => {},
    goalControl: nativeControl,
    observeBackground: (value) => {
      observer = value;
    },
  };
  const adapter = new GrokAdapter(
    { environment },
    { createTransport: () => transport, randomUUID, fetchCredits: async () => null },
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostic = new PassThrough();
  const collector = new JsonLineCollector(output);
  const official = new FakeOfficialProcess();
  const store = new MappingStore({ directory: path.join(root, "mapping") });
  const host = new AppServerHost({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    desktopInput: input,
    desktopOutput: output,
    diagnosticOutput: diagnostic,
    mappingStore: store,
    environment,
    externalAdapters: new Map([["grok", adapter]]),
    spawnOfficial: (() =>
      official as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
    officialCloseTimeoutMs: 50,
  });
  const running = host.run();
  try {
    writeRequest(input, {
      id: 1,
      method: "thread/start",
      params: { model: "codexhost/grok-native", cwd },
    });
    const opened = await collector.waitFor((m) => requestId(m, 1));
    expect(opened.error, JSON.stringify(opened)).toBeUndefined();
    const threadId = (opened.result as { thread: { id: string } }).thread.id;
    writeRequest(input, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "/goal smoke" }] },
    });
    const opening = await collector.waitFor((m) => requestId(m, 2));
    expect(opening.error).toBeUndefined();
    writeRequest(input, {
      id: 3,
      method: "thread/goal/set",
      params: { threadId, objective: "smoke", status: "active" },
    });
    expect(await collector.waitFor((m) => requestId(m, 3))).toMatchObject({
      result: { goal: { objective: "smoke", status: "active" } },
    });
    await collector.waitFor((m) => m.method === "turn/completed");
    expect(nativeControl).toHaveBeenCalledTimes(1);
    if (!observer) throw new Error("Grok background observer not installed");
    for (const round of [0, 1]) {
      const user: GrokTransportEvent = {
        type: "user.text",
        text: "<system-reminder>Continue the goal</system-reminder>",
        metadata: { promptIndex: round },
      };
      const agent: GrokTransportEvent = {
        type: "agent.text",
        text: `worker ${round}`,
        messageId: `answer-${round}`,
      };
      const terminal: GrokTransportEvent = {
        type: "turn.completed",
        nativeTurnKey: `native-worker-${round}`,
        stopReason: "end_turn",
      };
      history.push(user, agent, terminal);
      const start = collector.messages.length;
      observer.onEvent(agent);
      observer.onEvent(terminal);
      await vi.waitFor(() =>
        expect(
          collector.messages.slice(start).find((m) => m.method === "turn/completed"),
        ).toMatchObject({ params: { turn: { status: "completed" } } }),
      );
      const messages = collector.messages.slice(start);
      expect(messages.findIndex((m) => m.method === "turn/started")).toBeGreaterThanOrEqual(0);
      expect(messages.findIndex((m) => m.method === "item/started")).toBeGreaterThan(
        messages.findIndex((m) => m.method === "turn/started"),
      );
    }
    writeRequest(input, { id: 4, method: "thread/read", params: { threadId, includeTurns: true } });
    expect(await collector.waitFor((m) => requestId(m, 4))).toMatchObject({
      result: { thread: { turns: [{ status: "completed" }, { status: "completed" }] } },
    });
    expect((await store.getThread(hostThreadIdSchema.parse(threadId)))?.turnMappings).toHaveLength(
      2,
    );
    writeRequest(input, { id: 5, method: "thread/goal/clear", params: { threadId } });
    expect(await collector.waitFor((m) => requestId(m, 5))).toMatchObject({
      result: { cleared: true },
    });
    expect(diagnostic.read()?.toString() ?? "").not.toContain("External Harness output failed");
  } finally {
    input.end();
    await running;
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.env.CODEXHOST_GROK_GOAL_HOST_LIVE !== "1")(
  "projects native Grok worker output and pause through the full Host goal path",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-host-live-"));
    const cwd = path.join(root, "project");
    const home = path.join(root, "grok");
    await mkdir(cwd);
    await mkdir(home);
    await copyFile(
      path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json"),
      path.join(home, "auth.json"),
    );
    const environment = {
      ...process.env,
      GROK_HOME: home,
      GROKGOD_UPDATE_CHECK_DISABLE: "1",
      CODEXHOST_DATA_DIR: path.join(root, "host"),
    };
    const adapter = new GrokAdapter({ environment });
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostic = new PassThrough();
    const collector = new JsonLineCollector(output);
    const official = new FakeOfficialProcess();
    const store = new MappingStore({ directory: path.join(root, "mapping") });
    const host = new AppServerHost({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server"],
      desktopInput: input,
      desktopOutput: output,
      diagnosticOutput: diagnostic,
      mappingStore: store,
      environment,
      externalAdapters: new Map([["grok", adapter]]),
      spawnOfficial: (() =>
        official as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
      officialCloseTimeoutMs: 50,
    });
    const running = host.run();
    const response = async (id: number, timeout = 35_000) => {
      await vi.waitFor(() => expect(collector.messages.some((m) => requestId(m, id))).toBe(true), {
        timeout,
        interval: 50,
      });
      const result = collector.messages.find((m) => requestId(m, id));
      if (!result) throw new Error(`Missing Host response ${id}`);
      expect(result?.error, JSON.stringify(result)).toBeUndefined();
      return result;
    };
    try {
      writeRequest(input, {
        id: 1,
        method: "thread/start",
        params: { model: "codexhost/grok-native", cwd },
      });
      const opened = await response(1);
      const threadId = (opened.result as { thread: { id: string } }).thread.id;
      const objective = `Write ${path.join(cwd, "smoke.txt")} with one line ok plus the current UTC ISO timestamp, then stop. Do not modify any other files.`;
      writeRequest(input, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: `/goal ${objective}` }] },
      });
      const opening = await response(2);
      const openingId = (opening.result as { turn: { id: string } }).turn.id;
      writeRequest(input, {
        id: 3,
        method: "thread/goal/set",
        params: { threadId, objective, status: "active" },
      });
      expect(await response(3)).toMatchObject({
        result: { goal: { objective, status: "active" } },
      });
      await vi.waitFor(
        () =>
          expect(
            collector.messages.some(
              (m) =>
                m.method === "item/started" &&
                (m.params as { turnId?: string })?.turnId !== openingId,
            ),
          ).toBe(true),
        { timeout: 180_000, interval: 100 },
      );
      const workerStart = collector.messages.find(
        (m) =>
          m.method === "turn/started" &&
          (m.params as { turn?: { id?: string } })?.turn?.id !== openingId,
      );
      expect(workerStart).toBeDefined();
      const workerId = (workerStart?.params as { turn: { id: string } }).turn.id;
      writeRequest(input, {
        id: 4,
        method: "thread/goal/set",
        params: { threadId, status: "paused" },
      });
      expect(await response(4)).toMatchObject({ result: { goal: { status: "paused" } } });
      await vi.waitFor(
        () =>
          expect(
            collector.messages.find(
              (m) =>
                m.method === "turn/completed" &&
                (m.params as { turn?: { id?: string } })?.turn?.id === workerId,
            ),
          ).toMatchObject({ params: { turn: { status: "interrupted" } } }),
        { timeout: 10_000 },
      );
      const record = await store.getThread(hostThreadIdSchema.parse(threadId));
      expect(record?.turnMappings).toHaveLength(1);
      expect(record?.turnMappings[0]?.nativeTurnRef.nativeTurnKey).toBeTruthy();
      writeRequest(input, { id: 5, method: "thread/goal/clear", params: { threadId } });
      expect(await response(5)).toMatchObject({ result: { cleared: true } });
      expect(diagnostic.read()?.toString() ?? "").not.toContain("precedes turn.started");
    } finally {
      input.end();
      await running;
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
