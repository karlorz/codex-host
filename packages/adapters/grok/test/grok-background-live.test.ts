import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { harnessModelRefSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HostEvent } from "@codexhost/harness-adapter";
import { GrokAdapter } from "../src/grok-adapter.js";

it.skipIf(process.env.CODEXHOST_GROK_BACKGROUND_LIVE !== "1")(
  "settles two real isolated monitor responses and restores their native identities",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-background-live-"));
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
      const reading = (async () => {
        for await (const output of session.outputs)
          if (output.kind === "event") events.push(output.event);
      })();
      const prompt =
        "Use the native monitor tool exactly once with command " +
        JSON.stringify(
          "sleep 30; printf 'DONE codexhost-cycle-1\\n'; sleep 60; printf 'DONE codexhost-cycle-2\\n'",
        ) +
        ', description "disposable two-cycle codexhost smoke", timeout_ms 110000, persistent false. Then reply only "started" and finish this Turn. On each later monitor notification reply one short acknowledgement containing its cycle number and finish that Turn. Do not poll, wait, sleep, or call other tools after starting the monitor. Do not create goals or modify files. The monitor command exits by itself after exactly two events.';
      expect(
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("monitor-opening"),
          input: [{ type: "text", text: prompt }],
        }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(
        () =>
          expect(
            events.some((e) => e.type === "turn.completed" && e.turnId === "monitor-opening"),
          ).toBe(true),
        { timeout: 60000, interval: 100 },
      );
      await vi.waitFor(
        () => {
          const failed = events.find(
            (e) => e.type === "turn.completed" && e.outcome.status === "failed",
          );
          expect(failed, JSON.stringify(failed)).toBeUndefined();
          expect(
            events.filter(
              (e) =>
                e.type === "turn.completed" &&
                e.turnId !== "monitor-opening" &&
                e.nativeTurnRef &&
                e.outcome.status === "succeeded",
            ).length,
          ).toBeGreaterThanOrEqual(2);
        },
        { timeout: 150000, interval: 100 },
      );
      const completed = events.filter(
        (e) => e.type === "turn.completed" && e.turnId !== "monitor-opening",
      );
      const keys = completed.flatMap((e) =>
        e.type === "turn.completed" && e.nativeTurnRef ? [e.nativeTurnRef.nativeTurnKey] : [],
      );
      expect(new Set(keys).size).toBe(keys.length);
      const snapshot = await session.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok)
        for (const key of keys)
          expect(snapshot.value.turns.some((t) => t.nativeTurnRef.nativeTurnKey === key)).toBe(
            true,
          );
      console.info(
        JSON.stringify({ nativeMonitorCycles: keys.length, keys, historyRestored: snapshot.ok }),
      );
      await session.close();
      await reading;
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  240000,
);
