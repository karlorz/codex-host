import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { GrokBackgroundItems } from "../src/grok-background-items.js";

describe("GrokBackgroundItems", () => {
  it("retains native truncation for short completion output", () => {
    const events: HostEvent[] = [];
    const items = new GrokBackgroundItems({
      outputLimit: 1000,
      emit: (event) => events.push(event),
    });
    items.follow({
      turnId: hostTurnIdSchema.parse("t"),
      callId: "c",
      taskId: "p",
      kind: "run",
      description: "test",
      item: { type: "commandExecution", itemId: hostItemIdSchema.parse("i"), command: "test" },
    });
    items.settle("p", { status: "succeeded" }, "clipped", undefined, 0, true);
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({
      snapshot: { item: { output: "clipped", outputTruncated: true, exitCode: 0 } },
    });
  });
  let tempDir: string;
  let events: HostEvent[];
  let items: GrokBackgroundItems;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grok-bg-items-test-"));
    events = [];
    items = new GrokBackgroundItems({
      outputLimit: 100,
      emit: (e) => events.push(e),
    });
  });

  afterEach(async () => {
    items.abandonAll("test end");
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("follows and tracks running tasks and taskIds", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "sleep 10",
      item: {
        type: "commandExecution",
        itemId,
        command: "sleep 10",
      },
    });

    expect(items.taskIds()).toEqual(["task-1"]);
    expect(items.hasCallId("call-1")).toBe(true);
    expect(items.hasCallId("call-unknown")).toBe(false);
    expect(items.running()).toHaveLength(1);
    expect(items.running()[0]?.taskId).toBe("task-1");
    expect(items.commandItemId("task-1")).toBe(itemId);
    expect(items.commandItemId("unknown-task")).toBeUndefined();
  });

  it("settles task and preserves actual exitCode when supplied", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "run tests",
      item: {
        type: "commandExecution",
        itemId,
        command: "run tests",
      },
    });

    const settled = items.settle(
      "task-1",
      { status: "failed", error: { code: "nativeFailure", message: "fail", retryable: false } },
      "output so far",
      undefined,
      42,
    );

    expect(settled).toBe(true);
    expect(items.taskIds()).toEqual([]);
    expect(items.running()).toHaveLength(0);
    expect(items.commandItemId("task-1")).toBe(itemId);

    const completed = events.find((e) => e.type === "item.completed");
    expect(completed).toBeDefined();
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        type: "commandExecution",
        exitCode: 42,
        output: "output so far",
      });
      expect(completed.snapshot.outcome.status).toBe("failed");
    }
  });

  it("preserves exitCode 0 when supplied for succeeded outcome", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "echo hi",
      item: {
        type: "commandExecution",
        itemId,
        command: "echo hi",
      },
    });

    items.settle("task-1", { status: "succeeded" }, "hi\n", undefined, 0);

    const completed = events.find((e) => e.type === "item.completed");
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        exitCode: 0,
        output: "hi\n",
      });
    }
  });

  it("preserves null exitCode when explicitly passed", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "aborted task",
      item: {
        type: "commandExecution",
        itemId,
        command: "aborted task",
      },
    });

    items.settle("task-1", { status: "cancelled", reason: "aborted" }, undefined, undefined, null);

    const completed = events.find((e) => e.type === "item.completed");
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        exitCode: null,
      });
      expect(completed.snapshot.outcome.status).toBe("cancelled");
    }
  });

  it("uses cumulative snapshots with replaceSnapshot and avoids duplication", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "build",
      item: {
        type: "commandExecution",
        itemId,
        command: "build",
        output: "init",
      },
    });

    // Cumulative snapshot 1: "init: step 1\n"
    items.replaceSnapshot("call-1", "init: step 1\n");
    // Cumulative snapshot 2: "init: step 1\nstep 2\n"
    items.replaceSnapshot("call-1", "init: step 1\nstep 2\n");

    const appends = events.filter((e) => e.type === "item.updated");
    expect(appends).toHaveLength(2);
    expect(appends[0]).toMatchObject({
      update: { type: "output.append", text: ": step 1\n" },
    });
    expect(appends[1]).toMatchObject({
      update: { type: "output.append", text: "step 2\n" },
    });

    items.settle("task-1", { status: "succeeded" }, "init: step 1\nstep 2\n");
    const completed = events.find((e) => e.type === "item.completed");
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        output: "init: step 1\nstep 2\n",
      });
    }
  });

  it("handles non-prefix snapshot replacement in replaceSnapshot", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "status",
      item: {
        type: "commandExecution",
        itemId,
        command: "status",
      },
    });

    items.replaceSnapshot("call-1", "line A\n");
    // Non-prefix rewrite (e.g. carriage return or full redraw)
    items.replaceSnapshot("call-1", "line B\n");

    const appends = events.filter((e) => e.type === "item.updated");
    expect(appends).toHaveLength(1);

    items.settle("task-1", { status: "succeeded" });
    const completed = events.find((e) => e.type === "item.completed");
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        output: "line B\n",
      });
    }
  });

  it("treats native output file as primary when supplied, ignoring monitor/snapshot append", async () => {
    const logFile = join(tempDir, "proc.log");
    await writeFile(logFile, "line 1\nline 2\n", "utf8");

    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "server",
      outputFile: logFile,
      item: {
        type: "commandExecution",
        itemId,
        command: "server",
      },
    });

    // When outputFile is primary, monitor append / snapshot are ignored to prevent duplication
    const appendResult = items.append("task-1", "duplicate line\n");
    expect(appendResult).toBe(true);

    const snapshotResult = items.replaceSnapshot("call-1", "duplicate snapshot");
    expect(snapshotResult).toBe(true);

    expect(events.filter((e) => e.type === "item.updated")).toHaveLength(0);

    items.settle("task-1", { status: "succeeded" }, "ignored settle output", logFile, 0);

    // Wait for the settle poll/read to finish
    await new Promise((resolve) => setTimeout(resolve, 50));

    const completed = events.find((e) => e.type === "item.completed");
    expect(completed).toBeDefined();
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        output: "line 1\nline 2\n",
        exitCode: 0,
      });
    }
  });

  it("appends monitor lines only when there is no file", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "monitor",
      description: "watch build",
      item: {
        type: "commandExecution",
        itemId,
        command: "watch build",
      },
    });

    items.append("task-1", "event 1\n");
    items.append("task-1", "event 2\n");

    const appends = events.filter((e) => e.type === "item.updated");
    expect(appends).toHaveLength(2);
    expect(appends[0]).toMatchObject({
      update: { type: "output.append", text: "event 1\n" },
    });
    expect(appends[1]).toMatchObject({
      update: { type: "output.append", text: "event 2\n" },
    });

    items.settle("task-1", { status: "succeeded" });
    const completed = events.find((e) => e.type === "item.completed");
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        output: "event 1\nevent 2\n",
      });
    }
  });

  it("stops polling and avoids repeated full reread after truncation", async () => {
    const smallLimitItems = new GrokBackgroundItems({
      outputLimit: 20,
      emit: (e) => events.push(e),
    });

    const logFile = join(tempDir, "long.log");
    await writeFile(logFile, "01234567890123456789extra characters beyond twenty", "utf8");

    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    smallLimitItems.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "generate long output",
      outputFile: logFile,
      item: {
        type: "commandExecution",
        itemId,
        command: "generate long output",
      },
    });

    smallLimitItems.settle("task-1", { status: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const completed = events.find((e) => e.type === "item.completed");
    expect(completed).toBeDefined();
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.item).toMatchObject({
        output: "01234567890123456789",
        outputTruncated: true,
      });
    }
  });

  it("maintains bounded tombstones for completed identity and ignores subsequent duplicate settle or follow", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "quick task",
      item: {
        type: "commandExecution",
        itemId,
        command: "quick task",
      },
    });

    expect(items.hasCallId("call-1")).toBe(true);
    items.settle("task-1", { status: "succeeded" }, "done", undefined, 0);

    // After completion, hasCallId remains true via tombstone
    expect(items.hasCallId("call-1")).toBe(true);
    expect(items.taskIds()).toHaveLength(0);

    // Duplicate settle returns true without re-emitting
    const eventCountBefore = events.length;
    const secondSettle = items.settle("task-1", {
      status: "failed",
      error: { code: "nativeFailure", message: "fail", retryable: false },
    });
    expect(secondSettle).toBe(true);
    expect(events.length).toBe(eventCountBefore);

    // Re-follow on tombstone is a no-op
    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "quick task again",
      item: {
        type: "commandExecution",
        itemId,
        command: "quick task again",
      },
    });
    expect(items.taskIds()).toHaveLength(0);
  });

  it("abandonAll cancels polling timers and completes all active items", () => {
    const turnId = hostTurnIdSchema.parse("turn-1");
    const itemId = hostItemIdSchema.parse("item-1");

    items.follow({
      turnId,
      callId: "call-1",
      taskId: "task-1",
      kind: "run",
      description: "abandon me",
      item: {
        type: "commandExecution",
        itemId,
        command: "abandon me",
      },
    });

    items.abandonAll("session closing");
    expect(items.taskIds()).toHaveLength(0);

    const completed = events.find((e) => e.type === "item.completed");
    expect(completed).toBeDefined();
    if (completed?.type === "item.completed") {
      expect(completed.snapshot.outcome).toMatchObject({
        status: "cancelled",
        reason: "session closing",
      });
    }
  });
});
