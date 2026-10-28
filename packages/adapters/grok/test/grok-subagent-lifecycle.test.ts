import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { GrokSubagentLifecycle } from "../src/grok-subagent-lifecycle.js";

const turnId = hostTurnIdSchema.parse("turn");

function fixture() {
  const events: HostEvent[] = [];
  let nextId = 0;
  const lifecycle = new GrokSubagentLifecycle({
    newItemId: () => hostItemIdSchema.parse(`item-${++nextId}`),
    emit: (event) => events.push(event),
  });
  return { events, lifecycle };
}

function start(lifecycle: GrokSubagentLifecycle, index: number, nativeSubagentId?: string) {
  lifecycle.start(turnId, {
    callId: `call-${index}`,
    operation: "spawn",
    description: `Review ${index}`,
    background: true,
    ...(nativeSubagentId ? { nativeSubagentId } : {}),
  });
}

describe("Grok Subagent publication", () => {
  it("publishes four native children without exposing four temporary call identities", () => {
    const { lifecycle, events } = fixture();
    for (let index = 0; index < 4; index++) start(lifecycle, index);
    expect(lifecycle.size).toBe(4);
    expect(events).toEqual([]);

    for (const index of [1, 2, 0, 3]) {
      const nativeSubagentId = `native-${index}`;
      lifecycle.bindNativeId(turnId, { nativeSubagentId, description: `Review ${index}` });
      lifecycle.completeSpawn(turnId, `call-${index}`, {
        nativeSubagentId,
        failed: false,
        cancellationRequested: false,
      });
      lifecycle.completeByNativeId(turnId, nativeSubagentId, {
        failed: false,
        cancellationRequested: false,
      });
    }

    const started = events.filter((event) => event.type === "item.started");
    expect(started).toHaveLength(4);
    expect(
      started.map((event) => event.item.type === "subagentDelegation" && event.item.subagents[0]),
    ).toEqual(
      [1, 2, 0, 3].map((index) =>
        expect.objectContaining({
          subagentId: `native-${index}`,
          nativeSubagentId: `native-${index}`,
        }),
      ),
    );
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(4);
    expect(lifecycle.size).toBe(0);
  });

  it("publishes a child identity supplied directly by the spawn result", () => {
    const { lifecycle, events } = fixture();
    start(lifecycle, 0);
    lifecycle.completeSpawn(turnId, "call-0", {
      nativeSubagentId: "native-0",
      failed: false,
      cancellationRequested: false,
    });
    expect(events[0]).toMatchObject({
      type: "item.started",
      item: { subagents: [{ subagentId: "native-0", nativeSubagentId: "native-0" }] },
    });
  });

  it("preserves a failed spawn without a native child as a terminal delegation", () => {
    const { lifecycle, events } = fixture();
    start(lifecycle, 0);
    lifecycle.completeSpawn(turnId, "call-0", { failed: true, cancellationRequested: false });
    expect(events.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    expect(events[0]).toMatchObject({
      item: { subagents: [{ subagentId: "call-0", status: "failed" }] },
    });
    expect(events[1]).toMatchObject({
      snapshot: { outcome: { status: "failed" }, item: { subagents: [{ status: "failed" }] } },
    });
  });

  it("settles an unpublished delegation when its parent is cancelled", () => {
    const { lifecycle, events } = fixture();
    start(lifecycle, 0);
    lifecycle.finalize(turnId, { status: "cancelled", reason: "Cancelled by user" });
    expect(events.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    expect(events[1]).toMatchObject({
      snapshot: { item: { subagents: [{ status: "interrupted" }] } },
    });
  });

  it("immediately publishes send operations with an existing native child", () => {
    const { lifecycle, events } = fixture();
    lifecycle.start(turnId, {
      callId: "send",
      nativeSubagentId: "native-child",
      operation: "send",
      description: "Follow up",
      background: true,
    });
    expect(events[0]).toMatchObject({
      type: "item.started",
      item: { operation: "send", subagents: [{ subagentId: "native-child" }] },
    });
  });
});
