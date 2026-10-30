import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { GrokAdapter } from "../src/grok-adapter.js";

it.skipIf(
  process.env.CODEXHOST_GROK_GOAL_BRIDGE_LIVE !== "1" &&
    process.env.CODEXHOST_GROK_GOAL_CONTROL_LIVE !== "1",
)(
  "confirms a real native goal and observes its independent worker without a failed control Turn",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-goal-bridge-"));
    const home = path.join(root, "grok");
    const cwd = path.join(root, "project");
    await mkdir(home);
    await mkdir(cwd);
    await copyFile(
      path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json"),
      path.join(home, "auth.json"),
    );
    const adapter = new GrokAdapter({
      environment: { ...process.env, GROK_HOME: home, GROKGOD_UPDATE_CHECK_DISABLE: "1" },
    });
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        executionPolicy: "unattended-full-access",
        model: harnessModelRefSchema.parse({ id: "grok-4.6" }),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const events: HostEvent[] = [];
      const output = (async () => {
        for await (const value of session.outputs)
          if (value.kind === "event") events.push(value.event);
      })();
      const filename = path.join(cwd, `goal-${randomUUID()}.txt`);
      const goals = session.goals;
      if (!goals) throw new Error("Missing native goals capability");
      const set = await goals.set({
        objective: `Create ${filename} containing exactly one line: ok. Use a shell write, read it once to verify, then stop. This is a disposable empty workspace; change no other files.`,
        origin: "user",
      });
      if (!set.ok) throw new Error(set.error.message);
      expect(set.value.status).toBe("active");
      expect(session.hasBackgroundWork?.()).toBe(true);
      const deadline = Date.now() + 600_000;
      let completed = false;
      if (process.env.CODEXHOST_GROK_GOAL_CONTROL_LIVE === "1") {
        while (
          Date.now() < deadline &&
          !events.some((event) => event.type === "turn.autonomous.started")
        )
          await delay(100);
        expect(events.some((event) => event.type === "turn.autonomous.started")).toBe(true);
        const paused = await goals.set({ status: "paused", origin: "user" });
        if (!paused.ok) throw new Error(paused.error.message);
        expect(paused.value.status).toBe("paused");
        expect(
          events.some(
            (event) =>
              event.type === "turn.completed" &&
              event.nativeTurnRef &&
              event.outcome.status === "cancelled",
          ),
          JSON.stringify(events.filter((event) => event.type === "turn.completed")),
        ).toBe(true);
        const sourceRef = session.initialState.nativeRef;
        if (!sourceRef) throw new Error("Missing native Session identity");
        await session.close();
        await output;
        const reopened = await adapter.open({ kind: "resume", cwd, nativeRef: sourceRef });
        if (!reopened.ok) throw new Error(reopened.error.message);
        expect(await reopened.value.goals?.read()).toMatchObject({
          ok: true,
          value: { status: "paused" },
        });
        expect(await reopened.value.goals?.clear({ origin: null })).toMatchObject({
          ok: true,
          value: { cleared: true },
        });
        await reopened.value.close();
        return;
      }
      while (Date.now() < deadline) {
        const state = await goals.read();
        const failed = events.find(
          (e) => e.type === "turn.completed" && e.outcome.status === "failed",
        );
        if (failed) throw new Error(JSON.stringify(failed));
        if (
          state.ok &&
          state.value?.status === "complete" &&
          events.some((e) => e.type === "turn.completed")
        ) {
          completed = true;
          break;
        }
        await delay(250);
      }
      expect(completed, JSON.stringify(events.map((e) => e.type))).toBe(true);
      expect(events.some((e) => e.type === "turn.autonomous.started")).toBe(true);
      expect(
        events
          .filter((e) => e.type === "turn.completed")
          .every((e) => e.type === "turn.completed" && e.nativeTurnRef),
      ).toBe(true);
      expect((await readFile(filename, "utf8")).trim()).toBe("ok");
      expect(await goals.clear({ origin: null })).toMatchObject({
        ok: true,
        value: { cleared: true },
      });
      await session.close();
      await output;
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  660_000,
);
