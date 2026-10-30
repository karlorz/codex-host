import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GrokGoals, projectGrokGoal } from "../src/grok-goals.js";
const state = {
  goal_id: "goal-1",
  objective: "native goal",
  status: "active",
  token_budget: 1000,
  tokens_used_high_water: 42,
  elapsed_ms: 12345,
  created_at: "2026-10-30T06:49:54.871Z",
};
describe("Grok native goal controls", () => {
  it("coalesces Desktop's opening /goal and follow-up set only for the confirmed native identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-goals-desktop-"));
    await mkdir(path.join(directory, "goal"));
    const ready = Promise.withResolvers<undefined>();
    const control = vi.fn(async () => {
      await ready.promise;
      if (control.mock.calls.length > 1) return;
      await writeFile(path.join(directory, "goal/state.json"), JSON.stringify(state));
      await goals.observe({ ...state, tokens_used: 42 });
    });
    const goals = new GrokGoals(directory, control, () => {}, 150);
    const input = { objective: state.objective, tokenBudget: 1000, origin: null } as const;
    try {
      const opening = goals.set(input);
      const duplicate = goals.set({ ...input, status: "active" });
      ready.resolve(undefined);
      expect(await opening).toMatchObject({ ok: true, value: { status: "active" } });
      expect(await duplicate).toEqual(await goals.read());
      expect(await goals.set({ ...input, status: "active" })).toEqual(await goals.read());
      expect(control).toHaveBeenCalledTimes(1);
      await writeFile(
        path.join(directory, "goal/state.json"),
        JSON.stringify({ ...state, goal_id: "different-goal" }),
      );
      expect(await goals.set(input)).toMatchObject({ ok: false });
      expect(control).toHaveBeenCalledTimes(2);
    } finally {
      ready.resolve(undefined);
      goals.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("aborts pending control work at its deadline and never sends a late control", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-goal-deadline-"));
    await mkdir(path.join(directory, "goal"));
    await writeFile(
      path.join(directory, "goal/state.json"),
      JSON.stringify({ ...state, status: "complete" }),
    );
    const worker = Promise.withResolvers<undefined>();
    const sent = vi.fn();
    const goals = new GrokGoals(
      directory,
      async (_prompt, signal) => {
        await worker.promise;
        signal.throwIfAborted();
        sent();
      },
      () => {},
      30,
    );
    try {
      expect(await goals.clear()).toMatchObject({ ok: false });
      worker.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sent).not.toHaveBeenCalled();
    } finally {
      worker.resolve(undefined);
      goals.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("maps native high-water accounting and paused families without synthetic defaults", () => {
    expect(projectGrokGoal(state, 1793343010000)).toMatchObject({
      tokensUsed: 42,
      timeUsedSeconds: 12,
      createdAt: 1793342994,
      updatedAt: 1793343010,
      status: "active",
    });
    expect(projectGrokGoal({ ...state, status: "infra_paused" }, 1793343010000).status).toBe(
      "paused",
    );
    expect(() =>
      projectGrokGoal({ ...state, tokens_used_high_water: undefined }, 1793343010000),
    ).toThrow();
  });
  it("confirms native creation before the planner response settles and clears durably", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-goals-"));
    await mkdir(path.join(directory, "goal"));
    const changed = vi.fn();
    const planner = Promise.withResolvers<undefined>();

    const control = vi.fn(async (prompt: string) => {
      if (prompt === "/goal clear") {
        await rm(path.join(directory, "goal/state.json"));
        await goals.observe(null);
        return;
      }
      await writeFile(path.join(directory, "goal/state.json"), JSON.stringify(state));
      await goals.observe({ ...state, tokens_used: 42 });
      return planner.promise;
    });
    const goals = new GrokGoals(directory, control, changed, 500);
    try {
      expect(await goals.set({ objective: "native goal", origin: null })).toMatchObject({
        ok: true,
        value: { tokensUsed: 42, status: "active" },
      });
      expect(goals.active).toBe(true);
      expect(await goals.clear()).toEqual({ ok: true, value: { cleared: true } });
      expect(goals.active).toBe(false);
      expect(changed).toHaveBeenCalledWith(null);
    } finally {
      planner.resolve(undefined);
      goals.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not acknowledge a stale identical objective before native confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-goals-stale-"));
    await mkdir(path.join(directory, "goal"));
    await writeFile(path.join(directory, "goal/state.json"), JSON.stringify(state));
    const goals = new GrokGoals(
      directory,
      () => new Promise(() => {}),
      () => {},
      50,
    );
    try {
      expect(await goals.set({ objective: state.objective, origin: "user" })).toMatchObject({
        ok: false,
      });
    } finally {
      goals.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("waits for durable pause state after the native control reply", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-goals-pause-"));
    await mkdir(path.join(directory, "goal"));
    await writeFile(path.join(directory, "goal/state.json"), JSON.stringify(state));
    let persist: Promise<void> | undefined;
    const goals = new GrokGoals(
      directory,
      async () => {
        persist = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            void writeFile(
              path.join(directory, "goal/state.json"),
              JSON.stringify({ ...state, status: "user_paused" }),
            ).then(resolve, reject);
          }, 75);
        });
      },
      () => {},
      500,
    );
    try {
      expect(await goals.set({ status: "paused", origin: "user" })).toMatchObject({
        ok: true,
        value: { status: "paused" },
      });
      expect(goals.active).toBe(false);
    } finally {
      await persist;
      goals.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps pause pending until the worker cancellation and native control settle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-goals-cancel-"));
    await mkdir(path.join(directory, "goal"));
    await writeFile(path.join(directory, "goal/state.json"), JSON.stringify(state));
    const acknowledgement = Promise.withResolvers<undefined>();
    const goals = new GrokGoals(
      directory,
      async () => {
        const paused = { ...state, status: "user_paused" };
        await writeFile(path.join(directory, "goal/state.json"), JSON.stringify(paused));
        await goals.observe({ ...paused, tokens_used: 42 });
        await acknowledgement.promise;
      },
      () => {},
      500,
    );
    try {
      let settled = false;
      const result = goals.set({ status: "paused", origin: null }).then((value) => {
        settled = true;
        return value;
      });
      await vi.waitFor(() => expect(goals.active).toBe(false));
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      expect(goals.busy).toBe(true);
      acknowledgement.resolve(undefined);
      expect(await result).toMatchObject({ ok: true, value: { status: "paused" } });
    } finally {
      acknowledgement.resolve(undefined);
      goals.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
