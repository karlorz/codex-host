import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  createFixture,
  readJsonLine,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

it("preserves autonomous official turn order, terminal state and paginated history", async () => {
  const fixture = createFixture({ codexUsage: true });
  const threadId = "native-continuation-thread";
  const turns = ["native-first-turn", "native-continuation-1", "native-continuation-2"];
  const notifications: JsonObject[] = turns.flatMap((turnId) => [
    {
      method: "thread/status/changed",
      params: { threadId, status: { type: "active", activeFlags: [] } },
    },
    {
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } },
    },
    ...["commentary", "final_answer"].flatMap((phase) => {
      const itemId = `${turnId}-${phase}`;
      return [
        {
          method: "item/started",
          params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text: "", phase } },
        },
        {
          method: "item/agentMessage/delta",
          params: { threadId, turnId, itemId, delta: phase },
        },
        {
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { id: itemId, type: "agentMessage", text: phase, phase },
          },
        },
      ];
    }),
    {
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } },
    },
    { method: "thread/status/changed", params: { threadId, status: { type: "idle" } } },
  ]);

  try {
    await fixture.ready;
    // Goal continuations can begin without a Desktop turn/start request.
    // A single backend chunk also exercises ordering across asynchronous observers.
    fixture.official.stdout.write(
      notifications.map((message) => JSON.stringify(message)).join("\n") + "\n",
    );
    await vi.waitFor(() => {
      const delivered = fixture.collector.messages.filter((message) =>
        notifications.some((expected) => expected.method === message.method),
      );
      expect(delivered).toEqual(notifications);
    });

    const history = [...turns].reverse().map((id) => ({
      id,
      status: "completed",
      items: [
        { id: `${id}-commentary`, type: "agentMessage", text: "commentary", phase: "commentary" },
        {
          id: `${id}-final_answer`,
          type: "agentMessage",
          text: "final_answer",
          phase: "final_answer",
        },
      ],
    }));
    for (const [index, cursor] of [null, "older-page"].entries()) {
      const request = {
        id: 501 + index,
        method: "thread/turns/list",
        params: { threadId, limit: 2, sortDirection: "desc", cursor },
      };
      writeRequest(fixture.desktopInput, request);
      expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
      const response = {
        id: request.id,
        result: {
          data: index === 0 ? history.slice(0, 2) : history.slice(2),
          nextCursor: index === 0 ? "older-page" : null,
        },
      };
      writeRequest(fixture.official.stdout, response);
      expect(await fixture.collector.waitFor((message) => message.id === request.id)).toEqual(
        response,
      );
    }
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(await fixture.mappingStore.listThreads()).toEqual([]);
  } finally {
    await stopFixture(fixture);
  }
});
