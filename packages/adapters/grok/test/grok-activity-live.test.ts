import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { harnessModelRefSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { GrokAdapter } from "../src/grok-adapter.js";

it.skipIf(process.env.CODEXHOST_GROK_ACTIVITY_LIVE !== "1")(
  "lists and stops a disposable native Loop with real child output while parent input remains usable",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-activity-live-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(home);
    await mkdir(cwd);
    await copyFile(
      path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json"),
      path.join(home, "auth.json"),
    );
    // Custom model routing belongs in the disposable native home as well.
    await copyFile(
      path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "config.toml"),
      path.join(home, "config.toml"),
    );
    const adapter = new GrokAdapter({
      environment: { ...process.env, GROK_HOME: home, GROKGOD_UPDATE_CHECK_DISABLE: "1" },
    });
    let loopId: string | undefined;
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        executionPolicy: "unattended-full-access",
        model: harnessModelRefSchema.parse({
          id: process.env.CODEXHOST_GROK_ACTIVITY_LIVE_MODEL ?? "flash-max",
        }),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const native = opened.value;
      const events: HostEvent[] = [];
      const reading = (async () => {
        for await (const output of native.outputs)
          if (output.kind === "event") events.push(output.event);
      })();
      const activity = native.backgroundActivity;
      if (!activity) throw new Error("Missing activity capability");
      expect(
        await native.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("loop-opening"),
          input: [
            {
              type: "text",
              text: 'Use scheduler_create exactly once: interval "1m", fire_immediately true, prompt "Reply only DISPOSABLE_LOOP_OK and finish; use no tools and create no other activity." Then reply registered and finish. No goals, other background work or files. This is a disposable native integration test.',
            },
          ],
        }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(
        async () => {
          const listed = await activity.list();
          if (!listed.ok) throw new Error(listed.error.message);
          if (listed.ok) {
            loopId = listed.value.find((entry) => entry.kind === "loop")?.id;
            expect(loopId).toBeTruthy();
          }
        },
        { timeout: 20000, interval: 500 },
      );
      await vi.waitFor(
        () =>
          expect(
            events.some(
              (event) => event.type === "turn.completed" && event.turnId === "loop-opening",
            ),
          ).toBe(true),
        { timeout: 30000 },
      );
      expect(native.hasBackgroundWork?.()).toBe(true);
      expect(
        await native.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("loop-parent-input"),
          input: [
            { type: "text", text: "Reply only PARENT_INPUT_OK. Leave the disposable Loop alone." },
          ],
        }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(
        () =>
          expect(
            events.some(
              (event) => event.type === "turn.completed" && event.turnId === "loop-parent-input",
            ),
          ).toBe(true),
        { timeout: 40000 },
      );
      const childIds = new Set<string>();
      await vi.waitFor(
        async () => {
          const listed = await activity.list();
          if (!listed.ok) throw new Error(listed.error.message);
          const loop = listed.value.find((entry) => entry.id === loopId);
          expect(loop?.schedule).toBeTruthy();
          expect(loop?.nextRunAt).toBeTruthy();
          for (const child of listed.value.filter((entry) => entry.kind === "subagent")) {
            const detail = await activity.read(child.id);
            if (detail.ok && detail.value.output.includes("DISPOSABLE_LOOP_OK"))
              childIds.add(child.id);
          }
          expect(childIds.size).toBeGreaterThanOrEqual(2);
        },
        { timeout: 150000, interval: 1500 },
      );
      if (!loopId) throw new Error("Loop missing");
      expect(await activity.stop(loopId)).toEqual({ ok: true, value: { outcome: "stopped" } });
      expect(await activity.stop(loopId)).toEqual({ ok: true, value: { outcome: "notFound" } });
      const listed = await activity.list();
      expect(listed).toMatchObject({ ok: true });
      if (listed.ok) expect(listed.value.some((entry) => entry.id === loopId)).toBe(false);
      console.info(
        JSON.stringify({
          nativeLoopChildrenWithOutput: childIds.size,
          parentInputCompleted: true,
          nativeDeleteConfirmed: true,
        }),
      );
      await native.close();
      await reading;
    } finally {
      // Closing the disposable native process cancels its scheduler and owned children.
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  250000,
);

it.skipIf(process.env.CODEXHOST_GROK_ACTIVITY_LIVE !== "1")(
  "lists a disposable native background Run as running and stops it natively",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-activity-task-live-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(home);
    await mkdir(cwd);
    await copyFile(
      path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json"),
      path.join(home, "auth.json"),
    );
    // Custom native models need their configured provider in the isolated home.
    // Keep configuration local to the trial and never print its contents.
    await copyFile(
      path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "config.toml"),
      path.join(home, "config.toml"),
    );
    const adapter = new GrokAdapter({
      environment: { ...process.env, GROK_HOME: home, GROKGOD_UPDATE_CHECK_DISABLE: "1" },
    });
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        executionPolicy: "unattended-full-access",
        model: harnessModelRefSchema.parse({
          id: process.env.CODEXHOST_GROK_ACTIVITY_LIVE_MODEL ?? "flash-max",
        }),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const native = opened.value;
      const reading = (async () => {
        for await (const output of native.outputs) void output;
      })();
      const activity = native.backgroundActivity;
      if (!activity) throw new Error("Missing activity capability");
      expect(
        await native.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("task-opening"),
          input: [
            {
              type: "text",
              text: "Use the native Run tool in background mode exactly once to execute: for i in $(seq 1 30); do echo LIVE_TASK_TICK; sleep 10; done. Once it is backgrounded reply started and finish without waiting for it. No schedules, Monitors, subagents, goals, files or other tools. This is a disposable native integration test.",
            },
          ],
        }),
      ).toMatchObject({ ok: true });
      let taskId: string | undefined;
      await vi.waitFor(
        async () => {
          const listed = await activity.list();
          if (!listed.ok) throw new Error(listed.error.message);
          const task = listed.value.find((entry) => entry.kind === "task");
          expect(task).toMatchObject({
            status: "running",
            canStop: true,
            commandItemId: expect.any(String),
          });
          taskId = task?.id;
        },
        { timeout: 90000, interval: 1000 },
      );
      if (!taskId) throw new Error("Task missing");
      expect(await activity.stop(taskId)).toEqual({ ok: true, value: { outcome: "stopped" } });
      await vi.waitFor(
        async () => {
          const listed = await activity.list();
          if (!listed.ok) throw new Error(listed.error.message);
          expect(listed.value.find((entry) => entry.id === taskId)?.status).not.toBe("running");
        },
        { timeout: 20000, interval: 1000 },
      );
      console.info(JSON.stringify({ nativeTaskListedRunning: true, nativeStopConfirmed: true }));
      await native.close();
      await reading;
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  150000,
);
