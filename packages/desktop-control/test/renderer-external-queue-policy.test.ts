import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installRendererExternalQueuePolicy } from "../src/renderer-external-queue-policy.js";
import { rendererHostRpcUsesExternalQueue } from "../src/renderer-host-rpc-discovery.js";

function metadataStore(...values: unknown[]) {
  return {
    familyBindings: new Map([
      [{}, new Map(values.map((value, i) => [i, { value: { get: () => value } }]))],
    ]),
  };
}

describe("Composer queue ownership", () => {
  it("uses loaded provider metadata and rejects unknown or ambiguous Host identities", () => {
    const external = {
      conversationId: "thread",
      hostId: "local",
      modelProvider: "codexhost",
      model: "codexhost/plugin-v1@7b226861726e6573734964223a2267726f6b227d",
    };
    expect(
      rendererHostRpcUsesExternalQueue(metadataStore(external, { ...external }), "thread"),
    ).toBe(true);
    expect(rendererHostRpcUsesExternalQueue(metadataStore(external), "other")).toBe(false);
    expect(
      rendererHostRpcUsesExternalQueue(
        metadataStore({ ...external, modelProvider: "openai" }),
        "thread",
      ),
    ).toBe(false);
    expect(
      rendererHostRpcUsesExternalQueue(
        metadataStore(external, { ...external, hostId: "remote" }),
        "thread",
      ),
    ).toBe(false);
    expect(
      rendererHostRpcUsesExternalQueue(
        metadataStore(external, { ...external, modelProvider: "openai" }),
        "thread",
      ),
    ).toBe(false);
  });
});

// Replay Desktop's real decision code, including its queue-mode override and
// active-vs-idle checks. A thread/queue/add mock alone misses optimistic steer.
const nativeSubmission = readFileSync(
  new URL("./fixtures/desktop-26.1027-submission.js", import.meta.url),
  "utf8",
);
type Message = {
  conversationId: string;
  message: { id: string; text: string; context: object };
  queueModeOverride?: string;
};
type Submission = {
  sendMessage(message: Message, prepare: () => Promise<unknown>): Promise<unknown>;
};

describe("Desktop native submission replay", () => {
  it.each([
    { provider: "codexhost", active: true, expected: "queued" },
    { provider: "codexhost", active: false, expected: "start" },
    { provider: "openai", active: true, expected: "steer" },
  ])(
    "$provider active=$active chooses $expected before presenting history",
    async ({ provider, active, expected }) => {
      const steer = vi.fn(async () => ({ kind: "steer", turnId: "current" }));
      const start = vi.fn(async () => "new-turn");
      const enqueue = vi.fn(async (_thread: string, message: Message["message"]) => ({
        status: "queued",
        messageId: message.id,
      }));
      const create = runInNewContext(nativeSubmission) as (options: unknown) => Submission;
      const submission = create({
        host: {
          needsResume: () => false,
          getActiveTurnId: () => (active ? "current" : null),
          hasPendingTurnStart: () => false,
          hasFinalAnswer: () => false,
          steer,
          start,
        },
        isActive: () => true,
        isDurableThread: () => false,
        getQueueMode: async () => "send-now",
        enqueue,
      });
      const prepare = vi.fn(async () => ({
        conversationId: "thread",
        resume: { conversationId: "thread" },
        steer: {},
        start: {},
      }));
      const message: Message = {
        conversationId: "thread",
        message: { id: "follow-up", text: "reply Pong", context: {} },
      };
      let result: Promise<unknown> | undefined;
      const port = {
        postMessage(_message: unknown) {
          const expression = (_message as unknown[][])[1];
          const args = expression?.[3] as Message[];
          const input = args[0];
          if (!input) throw new Error("Missing native submission");
          result = submission.sendMessage(input, prepare);
        },
      };
      const store = metadataStore({
        conversationId: "thread",
        hostId: "local",
        modelProvider: provider,
      });
      const target = {};
      const policy = installRendererExternalQueuePolicy({}, target, {
        findStore: () => store,
        usesExternalQueue: rendererHostRpcUsesExternalQueue,
        portPrototype: port,
      });
      try {
        port.postMessage([
          "push",
          ["pipeline", -201, ["sendMessage"], [message, ["export", -1320]]],
        ]);
        await expect(result).resolves.toMatchObject(
          expected === "queued" ? { status: "queued" } : { status: "sent", kind: expected },
        );
        expect(enqueue).toHaveBeenCalledTimes(expected === "queued" ? 1 : 0);
        expect(steer).toHaveBeenCalledTimes(expected === "steer" ? 1 : 0);
        expect(start).toHaveBeenCalledTimes(expected === "start" ? 1 : 0);
        if (expected === "queued") expect(prepare).not.toHaveBeenCalled();
      } finally {
        policy?.dispose();
      }
    },
  );
});
