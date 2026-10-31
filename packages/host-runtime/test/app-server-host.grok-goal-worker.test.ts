import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, copyFile, readFile } from "node:fs/promises";
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

it.each(["native-worker", "subagent-completed", "task-completed", "persisted-boundary"])(
  "projects real Grok %s responses, helpers and housekeeping through the Host",
  async (prefix) => {
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
      cancel: vi.fn(async () => {}),
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
      expect(
        collector.messages.filter(
          (m) =>
            m.method === "item/completed" &&
            (m.params as { item?: { type?: string } })?.item?.type === "agentMessage",
        ),
      ).toHaveLength(0);
      expect(nativeControl).toHaveBeenCalledTimes(1);
      if (!observer) throw new Error("Grok background observer not installed");
      const nativeObserver = observer;
      const helperIds = ["planner", "skeptic-1", "skeptic-2", "skeptic-3", "summarizer"];
      for (const id of helperIds) {
        const childDirectory = grokNativeSessionDirectory({ cwd, environment }, id);
        await mkdir(childDirectory, { recursive: true });
        await writeFile(
          path.join(childDirectory, "updates.jsonl"),
          [
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "helper input" },
              _meta: { promptIndex: 0 },
            },
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `child transcript ${id}` },
            },
            {
              sessionUpdate: "turn_completed",
              prompt_id: `child-turn-${id}`,
              stop_reason: "end_turn",
            },
          ]
            .map((update) => JSON.stringify({ params: { sessionId: id, update } }))
            .join("\n") + "\n",
        );
      }
      for (const round of [0, 1, 2]) {
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
          nativeTurnKey: `${prefix}-${round}`,
          stopReason: "end_turn",
        };
        const start = collector.messages.length;
        const emit = (event: GrokTransportEvent) => {
          history.push(event);
          nativeObserver.onEvent(event);
        };
        const helper = (id: string, summary?: string) => {
          emit({
            type: "subagent.spawned",
            nativeSubagentId: id,
            parentPromptId: `${prefix}-${round}`,
            childSessionId: id,
            attemptId: `attempt-${id}`,
            description: id === "summarizer" ? "goal summarizer" : id,
            model: id === "planner" ? "grok-4.6" : "sonnet",
          });
          emit({
            type: "subagent.finished",
            nativeSubagentId: id,
            status: "completed",
            ...(summary ? { resultSummary: summary } : {}),
          });
        };
        if (round === 0) helper("planner");
        emit(user);
        if (round === 0 && prefix === "persisted-boundary") {
          history.push(agent);
          nativeObserver.onEvent({ ...agent, text: "Live worker response." });
        } else if (round === 0 && prefix === "task-completed") {
          history.push(agent);
          nativeObserver.onEvent({ ...agent, text: "worker " });
        } else if (round === 1 && prefix === "native-worker") history.push(agent);
        else if (round < 2) emit(agent);
        if (round === 0) for (const id of helperIds.slice(1, -1)) helper(id);
        if (round === 1) {
          await vi.waitFor(() =>
            expect(collector.messages.slice(start).some((m) => m.method === "turn/started")).toBe(
              true,
            ),
          );
          const state = JSON.parse(await readFile(path.join(directory, "goal/state.json"), "utf8"));
          await writeFile(
            path.join(directory, "goal/state.json"),
            JSON.stringify({ ...state, status: "complete", elapsed_ms: 9000 }),
          );
          nativeObserver.onEvent({
            type: "goal.changed",
            update: { ...state, status: "complete", tokens_used: 512, elapsed_ms: 9000 },
          });
          await collector.waitFor(
            (m) =>
              m.method === "thread/goal/updated" &&
              (m.params as { goal?: { status?: string } })?.goal?.status === "complete",
          );
          writeRequest(input, { id: 50, method: "thread/goal/clear", params: { threadId } });
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(nativeControl.mock.calls.some(([prompt]) => prompt === "/goal clear")).toBe(false);
          expect(transport.cancel).not.toHaveBeenCalled();
          const summary = "Goal achieved: smoke file verified.";
          helper("summarizer", summary);
          // Grok persists the worker + GoalSummary echo without streaming the echo.
          const persisted = history.findLast(
            (e) => e.type === "agent.text" && e.messageId === agent.messageId,
          );
          if (persisted?.type !== "agent.text") throw new Error("Missing worker history");
          history.splice(history.indexOf(persisted), 1);
          history.push({ ...persisted, text: persisted.text + summary });
        }
        emit(terminal);
        await vi.waitFor(
          () =>
            expect(
              collector.messages.slice(start).find((m) => m.method === "turn/completed"),
              `round ${round}`,
            ).toMatchObject({ params: { turn: { status: "completed" } } }),
          { timeout: 5000 },
        );
        const messages = collector.messages.slice(start);
        if (round < 2) {
          const finals = messages.filter(
            (m) =>
              m.method === "item/completed" &&
              (m.params as { item?: { phase?: string } })?.item?.phase === "final_answer",
          );
          expect(finals.at(-1)).toMatchObject({
            params: {
              item: {
                text:
                  round === 1
                    ? "Goal achieved: smoke file verified."
                    : prefix === "persisted-boundary"
                      ? "Live worker response."
                      : agent.text,
              },
            },
          });
          const final = finals.at(-1);
          if (!final) throw new Error("Missing final answer notification");
          expect(messages.indexOf(final)).toBeLessThan(
            messages.findIndex((m) => m.method === "turn/completed"),
          );
          const answerStarts = messages.filter(
            (m) =>
              m.method === "item/started" &&
              (m.params as { item?: { type?: string } })?.item?.type === "agentMessage",
          );
          const ids = answerStarts.map((m) => (m.params as { item: { id: string } }).item.id);
          expect(new Set(ids).size).toBe(ids.length);
        }
        expect(messages.findIndex((m) => m.method === "turn/started")).toBeGreaterThanOrEqual(0);
        if (round < 2)
          expect(messages.findIndex((m) => m.method === "item/started")).toBeGreaterThan(
            messages.findIndex((m) => m.method === "turn/started"),
          );
        if (round === 1)
          expect(await collector.waitFor((m) => requestId(m, 50))).toMatchObject({
            result: { cleared: true },
          });
      }
      writeRequest(input, {
        id: 4,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      expect(await collector.waitFor((m) => requestId(m, 4))).toMatchObject({
        result: { thread: { turns: [{ status: "completed" }, { status: "completed" }] } },
      });
      expect(
        (await store.getThread(hostThreadIdSchema.parse(threadId)))?.turnMappings,
      ).toHaveLength(2);
      await vi.waitFor(async () =>
        expect((await store.listThreads()).filter((r) => r.subagent)).toHaveLength(5),
      );
      const children = (await store.listThreads()).filter((r) => r.subagent);
      for (const [index, child] of children.entries()) {
        const id = 100 + index;
        writeRequest(input, {
          id,
          method: "thread/turns/list",
          params: { threadId: child.hostThreadId, limit: 20, itemsView: "full" },
        });
        const read = await collector.waitFor((m) => requestId(m, id));
        expect(read.error, JSON.stringify(read)).toBeUndefined();
        expect(JSON.stringify(read.result)).toContain(
          `child transcript ${child.subagent?.nativeSubagentId}`,
        );
      }
      writeRequest(input, {
        id: 150,
        method: "thread/turns/list",
        params: { threadId, limit: 20, itemsView: "full" },
      });
      const parentHistory = await collector.waitFor((m) => requestId(m, 150));
      for (const child of children)
        expect(JSON.stringify(parentHistory.result)).toContain(child.hostThreadId);
      const originalMappings = (await store.getThread(hostThreadIdSchema.parse(threadId)))
        ?.turnMappings;
      writeRequest(input, {
        id: 151,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      await collector.waitFor((m) => requestId(m, 151));
      expect((await store.getThread(hostThreadIdSchema.parse(threadId)))?.turnMappings).toEqual(
        originalMappings,
      );
      writeRequest(input, { id: 5, method: "thread/goal/clear", params: { threadId } });
      expect(await collector.waitFor((m) => requestId(m, 5))).toMatchObject({
        result: { cleared: false },
      });
      expect(diagnostic.read()?.toString() ?? "").not.toContain("External Harness output failed");
    } finally {
      input.end();
      await running;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(
  process.env.CODEXHOST_GROK_GOAL_HOST_LIVE !== "1" &&
    process.env.CODEXHOST_GROK_GOAL_HOST_COMPLETE_LIVE !== "1",
)(
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
    const answeredApprovals = new Set<string | number>();
    const approvalTimer = setInterval(() => {
      for (const message of collector.messages) {
        if (
          message.method !== "mcpServer/elicitation/request" ||
          (typeof message.id !== "string" && typeof message.id !== "number") ||
          answeredApprovals.has(message.id)
        )
          continue;
        answeredApprovals.add(message.id);
        writeRequest(input, {
          id: message.id,
          result: { action: "accept", content: {}, _meta: null },
        });
      }
    }, 25);
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
      writeRequest(input, {
        id: 60,
        method: "codexhost/thread/permission-mode/select",
        params: { threadId, permissionModeId: "always-approve" },
      });
      await response(60);
      const completionTrial = process.env.CODEXHOST_GROK_GOAL_HOST_COMPLETE_LIVE === "1";
      const budget = completionTrial ? 150000 : undefined;
      const objective = `Write ${path.join(cwd, "smoke.txt")} with one line ok plus the current UTC ISO timestamp, then stop. Do not modify any other files.`;
      writeRequest(input, {
        id: 2,
        method: "turn/start",
        params: {
          threadId,
          input: [
            { type: "text", text: `/goal ${objective}${budget ? ` --budget ${budget}` : ""}` },
          ],
        },
      });
      const opening = await response(2);
      const openingId = (opening.result as { turn: { id: string } }).turn.id;
      writeRequest(input, {
        id: 3,
        method: "thread/goal/set",
        params: {
          threadId,
          objective,
          status: "active",
          ...(budget ? { tokenBudget: budget } : {}),
        },
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
      if (completionTrial) {
        await vi.waitFor(
          () =>
            expect(
              collector.messages.some(
                (m) =>
                  m.method === "thread/goal/updated" &&
                  (m.params as { goal?: { status?: string } })?.goal?.status === "complete",
              ),
            ).toBe(true),
          { timeout: 180000, interval: 100 },
        );
        writeRequest(input, { id: 4, method: "thread/goal/clear", params: { threadId } });
        expect(await response(4)).toMatchObject({ result: { cleared: true } });
        await vi.waitFor(
          () =>
            expect(
              collector.messages.find(
                (m) =>
                  m.method === "turn/completed" &&
                  (m.params as { turn?: { id?: string } })?.turn?.id === workerId,
              ),
            ).toMatchObject({ params: { turn: { status: "completed" } } }),
          { timeout: 10000 },
        );
        const workerEnd = collector.messages.findIndex(
          (m) =>
            m.method === "turn/completed" &&
            (m.params as { turn?: { id?: string } })?.turn?.id === workerId,
        );
        const liveFinals = collector.messages
          .slice(0, workerEnd)
          .filter(
            (m) =>
              m.method === "item/completed" &&
              (m.params as { turnId?: string; item?: { phase?: string } })?.turnId === workerId &&
              (m.params as { item?: { phase?: string } })?.item?.phase === "final_answer",
          );
        expect(liveFinals.length).toBeGreaterThan(0);
        expect((liveFinals.at(-1)?.params as { item: { text: string } }).item.text.trim()).not.toBe(
          "",
        );
        expect(
          collector.messages.filter(
            (m) =>
              m.method === "item/completed" &&
              (m.params as { turnId?: string; item?: { type?: string } })?.turnId === openingId &&
              (m.params as { item?: { type?: string } })?.item?.type === "agentMessage",
          ),
        ).toHaveLength(0);
        const children = (await store.listThreads()).filter((r) => r.subagent);
        expect(children.length).toBeGreaterThanOrEqual(5);
        for (const [index, child] of children.entries()) {
          writeRequest(input, {
            id: 100 + index,
            method: "thread/turns/list",
            params: { threadId: child.hostThreadId, limit: 20, itemsView: "full" },
          });
          const snapshot = await response(100 + index);
          expect((snapshot.result as { data: unknown[] }).data.length).toBeGreaterThan(0);
        }
        expect(await readFile(path.join(cwd, "smoke.txt"), "utf8")).toMatch(/^ok .+Z\n$/u);
        console.info(
          JSON.stringify({
            nativeCompletion: true,
            approvedTestRequests: answeredApprovals.size,
            parentTurn: "completed",
            clear: true,
            children: children.map((c) => ({ id: c.subagent?.nativeSubagentId })),
            budget,
          }),
        );
        return;
      }
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
      clearInterval(approvalTimer);
      const wireErrors = collector.messages
        .filter((m) => m.method === "error")
        .map((m) => (m.params as { error: { message: string } }).error.message);
      if (wireErrors.length) console.info(JSON.stringify({ wireErrors }));
      input.end();
      await adapter.close();
      await running;
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
