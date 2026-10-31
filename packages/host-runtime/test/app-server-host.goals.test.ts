import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeHarnessPluginRoute, harnessPluginRouteSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import type { HarnessGoalCapability, HarnessSession } from "@codexhost/harness-adapter";
import type { HarnessGoal } from "@codexhost/shared-contracts";
import {
  closeFixture,
  createFixture,
  startExternalThread,
  JsonLineCollector,
  requestId,
  startPiThread,
  writeRequest,
} from "./app-server-host-fixture.js";

const goal: HarnessGoal = {
  objective: "native objective",
  status: "active",
  tokenBudget: 100,
  tokensUsed: 5,
  timeUsedSeconds: 2,
  createdAt: 10,
  updatedAt: 12,
};
function attach(session: HarnessSession) {
  const capability: HarnessGoalCapability = {
    read: vi.fn<HarnessGoalCapability["read"]>(async () => ({ ok: true, value: goal })),
    set: vi.fn<HarnessGoalCapability["set"]>(async (input) => ({
      ok: true,
      value: {
        ...goal,
        objective: input.objective ?? goal.objective,
        tokenBudget: input.tokenBudget === undefined ? goal.tokenBudget : input.tokenBudget,
        status: input.status ?? goal.status,
      },
    })),
    clear: vi.fn<HarnessGoalCapability["clear"]>(async () => ({
      ok: true,
      value: { cleared: true },
    })),
  };
  Object.assign(session, { goals: capability });
  return capability;
}
describe("external native goal routing", () => {
  it.each(["native read", "native event"])(
    "discards stale completion restoration after a concurrent %s",
    async (change) => {
      const f = createFixture();
      const loaded = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      try {
        const threadId = await startPiThread(f);
        const session = f.adapter.sessions[0];
        if (!session) throw new Error("Missing Session");
        const goals = attach(session);
        goals.read = vi.fn<HarnessGoalCapability["read"]>(async () => ({ ok: true, value: null }));
        goals.readLastCompleted = vi.fn<NonNullable<HarnessGoalCapability["readLastCompleted"]>>(
          async () => {
            loaded.resolve(undefined);
            await release.promise;
            return { ok: true, value: { ...goal, status: "complete" as const } };
          },
        );
        writeRequest(f.desktopInput, { id: 30, method: "thread/goal/get", params: { threadId } });
        await loaded.promise;
        if (change === "native read")
          goals.read = vi.fn<HarnessGoalCapability["read"]>(async () => ({
            ok: true,
            value: goal,
          }));
        else {
          session.emitEvent({ type: "goal.changed", goal });
          await f.collector.waitFor((m) => m.method === "thread/goal/updated");
        }
        release.resolve(undefined);
        expect(await f.collector.waitFor((m) => requestId(m, 30))).toMatchObject({
          result: { goal: change === "native read" ? { ...goal, threadId } : null },
        });
        writeRequest(f.desktopInput, { id: 31, method: "thread/goal/clear", params: { threadId } });
        await f.collector.waitFor((m) => requestId(m, 31));
        expect(f.collector.messages.filter((m) => m.method === "thread/goal/cleared")).toEqual([]);
        expect(f.collector.messages.filter((m) => m.method === "thread/goal/updated")).toHaveLength(
          change === "native event" ? 1 : 0,
        );
      } finally {
        release.resolve(undefined);
        await closeFixture(f);
      }
    },
  );
  it("restores native completion display while the current goal remains cleared", async () => {
    const f = createFixture();
    try {
      const threadId = await startPiThread(f);
      const session = f.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const goals = attach(session);
      const completed = { ...goal, status: "complete" as const };
      goals.read = vi.fn<HarnessGoalCapability["read"]>(async () => ({ ok: true, value: null }));
      goals.readLastCompleted = vi.fn<NonNullable<HarnessGoalCapability["readLastCompleted"]>>(
        async () => ({ ok: true, value: completed }),
      );
      writeRequest(f.desktopInput, { id: 20, method: "thread/goal/get", params: { threadId } });
      expect(await f.collector.waitFor((m) => requestId(m, 20))).toMatchObject({
        result: { goal: null },
      });
      expect(await f.collector.waitFor((m) => m.method === "thread/goal/updated")).toMatchObject({
        params: { threadId, goal: { ...completed, threadId } },
      });
      await f.collector.waitFor((m) => m.method === "thread/goal/cleared");
      expect(goals.set).not.toHaveBeenCalled();
      expect(goals.clear).not.toHaveBeenCalled();
      expect(f.collector.messages.filter((m) => m.method === "turn/started")).toEqual([]);
      goals.read = vi.fn<HarnessGoalCapability["read"]>(async () => ({ ok: true, value: goal }));
      vi.mocked(goals.readLastCompleted)?.mockClear();
      writeRequest(f.desktopInput, { id: 21, method: "thread/goal/get", params: { threadId } });
      await f.collector.waitFor((m) => requestId(m, 21));
      expect(goals.readLastCompleted).not.toHaveBeenCalled();
    } finally {
      await closeFixture(f);
    }
  });
  it("rejects unsupported external operations without official fall-through", async () => {
    const f = createFixture();
    const official = new JsonLineCollector(f.official.stdin);
    try {
      const threadId = await startPiThread(f);
      for (const [id, suffix] of [
        [10, "get"],
        [11, "set"],
        [12, "clear"],
      ] as const) {
        writeRequest(f.desktopInput, {
          id,
          method: `thread/goal/${suffix}`,
          params: { threadId, objective: "no fallback" },
        });
        expect(await f.collector.waitFor((m) => requestId(m, id))).toMatchObject({
          error: { code: -32076 },
        });
      }
      expect(official.messages.filter((m) => String(m.method).startsWith("thread/goal/"))).toEqual(
        [],
      );
    } finally {
      await closeFixture(f);
    }
  });
  it("uses native controls, preserves absent origin, and projects native accounting without creating Turns", async () => {
    const f = createFixture();
    try {
      const threadId = await startPiThread(f);
      const session = f.adapter.sessions[0];
      if (!session) throw new Error("Missing native Session");
      const goals = attach(session);
      for (const [id, suffix, params] of [
        [10, "get", {}],
        [11, "set", { status: "paused" }],
        [12, "clear", {}],
      ] as const) {
        writeRequest(f.desktopInput, {
          id,
          method: `thread/goal/${suffix}`,
          params: { threadId, ...params },
        });
        const response = await f.collector.waitFor((m) => requestId(m, id));
        expect(response.error).toBeUndefined();
        if (suffix === "get") expect(response.result).toEqual({ goal: { ...goal, threadId } });
      }
      writeRequest(f.desktopInput, {
        id: 13,
        method: "thread/goal/set",
        params: { threadId, origin: "system", status: "paused" },
      });
      expect(await f.collector.waitFor((m) => requestId(m, 13))).toMatchObject({
        error: { code: -32602 },
      });
      expect(goals.set).toHaveBeenCalledWith({ status: "paused", origin: null });
      expect(goals.clear).toHaveBeenCalledExactlyOnceWith({ origin: null });
      session.emitEvent({ type: "goal.changed", goal: { ...goal, status: "complete" } });
      expect(await f.collector.waitFor((m) => m.method === "thread/goal/updated")).toMatchObject({
        params: { threadId, goal: { ...goal, status: "complete", threadId } },
      });
      session.emitEvent({ type: "goal.changed", goal: null });
      expect(await f.collector.waitFor((m) => m.method === "thread/goal/cleared")).toMatchObject({
        params: { threadId },
      });
      expect(f.collector.messages.filter((m) => m.method === "turn/started")).toEqual([]);
      expect(await session.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
    } finally {
      await closeFixture(f);
    }
  });
  it("keeps official goal requests unchanged", async () => {
    const f = createFixture();
    const official = new JsonLineCollector(f.official.stdin);
    try {
      const request = {
        id: 99,
        method: "thread/goal/set",
        params: { threadId: "official-chat", objective: "official goal" },
      };
      writeRequest(f.desktopInput, request);
      expect(await official.waitFor((m) => requestId(m, 99))).toEqual(request);
      f.official.stdout.write(JSON.stringify({ id: 99, result: { goal: null } }) + "\n");
      await f.collector.waitFor((m) => requestId(m, 99));
    } finally {
      await closeFixture(f);
    }
  });
});

it("routes goals through a real dynamically loaded unknown-ID plugin", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goal-plugin-"));
  const location = path.join(directory, "native-goal-sample");
  await mkdir(location);
  await writeFile(
    path.join(directory, "enabled.json"),
    JSON.stringify({ version: 1, enabled: ["native-goal-sample"] }),
  );
  await writeFile(
    path.join(location, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "native-goal-sample",
      name: "Native goal sample",
      version: "1.0.0",
      adapterApiVersion: 1,
      entry: "index.mjs",
    }),
  );
  const fake = pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href;
  await writeFile(
    path.join(location, "index.mjs"),
    `
    import { FakeHarnessAdapter } from ${JSON.stringify(fake)};
    export function createHarnessAdapter(){
      const adapter=new FakeHarnessAdapter("native-goal-sample"); const open=adapter.open.bind(adapter);
      adapter.open=async(input)=>{const result=await open(input);if(result.ok){let goal=${JSON.stringify(goal)};
        result.value.goals={read:async()=>({ok:true,value:goal}),set:async(input)=>({ok:true,value:goal={...goal,status:input.status??goal.status}}),clear:async()=>({ok:true,value:{cleared:true}})};
      }return result;};return adapter;
    }
  `,
  );
  const f = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
  try {
    const threadId = await startExternalThread(
      f,
      encodeHarnessPluginRoute(harnessPluginRouteSchema.parse({ harnessId: "native-goal-sample" })),
    );
    writeRequest(f.desktopInput, { id: 10, method: "thread/goal/get", params: { threadId } });
    expect(await f.collector.waitFor((m) => requestId(m, 10))).toMatchObject({
      result: { goal: { ...goal, threadId } },
    });
    writeRequest(f.desktopInput, {
      id: 11,
      method: "thread/goal/set",
      params: { threadId, status: "paused" },
    });
    expect(await f.collector.waitFor((m) => requestId(m, 11))).toMatchObject({
      result: { goal: { status: "paused" } },
    });
  } finally {
    await closeFixture(f);
    await rm(directory, { recursive: true, force: true });
  }
});
