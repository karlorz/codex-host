import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { expect, it } from "vitest";
import { GrokAcpTransport } from "../src/acp-transport.js";
import { GrokAdapter } from "../src/grok-adapter.js";

it.skipIf(
  process.env.CODEXHOST_GROK_GOAL_HISTORY_LIVE !== "1" &&
    process.env.CODEXHOST_GROK_MODEL_HISTORY_LIVE !== "1",
)(
  process.env.CODEXHOST_GROK_MODEL_HISTORY_LIVE === "1"
    ? "rewinds real model-backed history to empty with the same Session identity"
    : "runs local goal controls without creating conversation Turns and preserves them on reopen",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-grok-goal-history-"));
    const grokHome = path.join(root, "grok");
    const cwd = path.join(root, "project");
    let adapter: GrokAdapter | undefined;
    try {
      await mkdir(grokHome, { mode: 0o700 });
      await mkdir(cwd);
      await copyFile(
        path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json"),
        path.join(grokHome, "auth.json"),
      );
      const sentinel = path.join(cwd, "keep.txt");
      await writeFile(sentinel, "workspace contents remain unchanged\n");
      const transports: GrokAcpTransport[] = [];
      adapter = new GrokAdapter(
        {
          ...(process.env.CODEXHOST_GROK_COMMAND
            ? { command: process.env.CODEXHOST_GROK_COMMAND }
            : {}),
          environment: { ...process.env, GROK_HOME: grokHome, GROKGOD_UPDATE_CHECK_DISABLE: "1" },
        },
        {
          randomUUID,
          createTransport: (options) => {
            const transport = new GrokAcpTransport(options);
            transports.push(transport);
            return transport;
          },
          fetchCredits: async () => null,
        },
      );
      const opened = await adapter.open({ kind: "create", cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const iterator = session.outputs[Symbol.asyncIterator]();
      const modelTrial = process.env.CODEXHOST_GROK_MODEL_HISTORY_LIVE === "1";
      for (const text of modelTrial
        ? ["Reply exactly FIRST. Do not use tools.", "Reply exactly SECOND. Do not use tools."]
        : ["status", "pause", "clear", "resume"]) {
        const turnId = hostTurnIdSchema.parse(randomUUID());
        const started = modelTrial
          ? await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] })
          : await session.commands?.execute({
              turnId,
              commandId: "grok.goal",
              arguments: { text },
            });
        expect(started).toMatchObject({ ok: true });
        let terminal: Extract<HostEvent, { type: "turn.completed" }> | undefined;
        for (;;) {
          const next = await iterator.next();
          if (next.done) throw new Error("Native output ended before goal control completed");
          if (next.value.kind === "event" && next.value.event.type === "turn.completed") {
            terminal = next.value.event;
            break;
          }
        }
        expect(
          terminal.outcome,
          terminal.outcome.status === "failed" ? terminal.outcome.error.message : text,
        ).toMatchObject({ status: "succeeded" });
      }
      const before = await session.readSnapshot();
      if (!before.ok) throw new Error(before.error.message);
      expect(before.value.turns.length).toBe(modelTrial ? 2 : 0);
      const checkpoint = before.value.turns[0]?.checkpoint;
      const sourceRef = session.initialState.nativeRef;
      if (!sourceRef) throw new Error("Missing native identity");
      await session.close();
      if (modelTrial) {
        if (!checkpoint) throw new Error("Missing native rewind boundary");
        const rewound = await adapter.open({
          kind: "rollbackToCheckpoint",
          cwd,
          sourceRef,
          checkpoint,
        });
        if (!rewound.ok) throw new Error(rewound.error.message);
        expect(await rewound.value.readSnapshot()).toMatchObject({
          ok: true,
          value: { turns: [] },
        });
        expect(rewound.value.initialState.nativeRef?.nativeSessionId).toBe(
          sourceRef.nativeSessionId,
        );
        expect(await readFile(sentinel, "utf8")).toBe("workspace contents remain unchanged\n");
        return;
      }
      const resumed = await adapter.open({ kind: "resume", cwd, nativeRef: sourceRef });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: before.value.turns },
      });
      expect(await readFile(sentinel, "utf8")).toBe("workspace contents remain unchanged\n");
      expect(await transports.at(-1)?.getUsage()).toMatchObject({ modelCalls: 0 });
    } finally {
      await adapter?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
