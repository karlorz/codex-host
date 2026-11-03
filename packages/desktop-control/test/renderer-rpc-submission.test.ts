import { expect, it, vi } from "vitest";
import {
  installRendererRpcSubmissionPreparation,
  type RendererRpcSubmissionContext,
} from "../src/renderer-rpc-submission.js";

function fixture(provider = "codexhost", withRegistry = false) {
  const dispatched = vi.fn();
  const native = {
    sendMessage: vi.fn(async (submission, prepare, ...rest) => {
      const result = await prepare(submission, "start");
      dispatched(result, ...rest);
      result[Symbol.dispose]?.();
      return "sent";
    }),
    sendQueuedMessageNow: vi.fn(async (threadId, id, options, prepare, ...rest) => {
      const result = await prepare({ conversationId: threadId, message: { id }, options }, "steer");
      dispatched(result, ...rest);
      result[Symbol.dispose]?.();
      return "queued";
    }),
  };
  const rpc = {
    startConversation: vi.fn(async (input: unknown, options: unknown) => ({ input, options })),
    getTurnCoordinator: vi.fn(async () => native),
    getConversation: vi.fn(async (id) => ({ id, modelProvider: provider })),
  };
  const connection = { status: "ready", client: { hostId: "local", rpc } };
  let current = connection;
  const signal = { get: () => current };
  const connections = new Map([["local", { value: signal }]]);
  const metadata = new Map([
    [
      "thread",
      {
        value: {
          get: () => ({ conversationId: "thread", hostId: "local", modelProvider: provider }),
        },
      },
    ],
  ]);
  const store = {
    familyBindings: new Map<unknown, Map<unknown, unknown>>([
      [{ kind: "signal-family" }, connections],
      [{ kind: "signal-family" }, metadata],
    ]),
  };
  const handle = { chain: {}, node: store, scope: {}, get() {}, set() {}, watch() {} };
  const container = {
    __reactContainer$app: { memoizedState: { memoizedState: { current: handle }, next: null } },
  };
  let mounted = true;
  const root = { getElementById: () => (mounted ? container : null) };
  const prepare = vi.fn(async (value: unknown, context: RendererRpcSubmissionContext) => {
    void context;
    return { ...(value as object), completed: true };
  });
  const readDraftModel = vi.fn((hostId: string, draftId: string): string | null =>
    hostId === "local" && draftId === "client-new-thread:external" ? "codexhost/grok-native" : null,
  );
  const nativeRpc = { ...rpc };
  const registry = {
    forHost: vi.fn((hostId: string) => {
      void hostId;
      return nativeRpc;
    }),
  };
  const originalForHost = registry.forHost;
  const hook = installRendererRpcSubmissionPreparation(
    root,
    prepare,
    readDraftModel,
    withRegistry ? () => registry : undefined,
  );
  return {
    hook,
    prepare,
    readDraftModel,
    registry,
    nativeRpc,
    originalForHost,
    root,
    rpc,
    native,
    dispatched,
    connection,
    metadata,
    connections,
    signal,
    setMounted(value: boolean) {
      mounted = value;
    },
    replaceConnection() {
      current = { ...connection, client: { ...connection.client, rpc } };
      return current;
    },
    retire() {
      current = { ...connection, status: "disconnected" };
    },
  };
}

it("wraps the authoritative native registry's cached RPC alias and restores both access paths", async () => {
  const f = fixture("codexhost", true);
  expect(f.nativeRpc).not.toBe(f.rpc);
  const manager = f.registry.forHost("local");
  expect(manager).not.toBe(f.nativeRpc);
  expect(f.connection.client.rpc).toBe(f.rpc);
  f.hook.refresh();
  expect(f.registry.forHost("local")).toBe(manager);
  await manager.startConversation(
    {
      input: [{ type: "image", url: "data:image/png;base64,aGVsbG8=" }],
      collaborationMode: { settings: { model: "gpt-native" } },
    },
    { clientThreadId: "client-new-thread:external" },
  );
  const coordinator = await manager.getTurnCoordinator();
  await coordinator.sendMessage({ conversationId: "thread" }, async () => ({}));
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.prepare.mock.calls[0]?.[1].manager).toBe(f.nativeRpc);
  f.hook.dispose();
  expect(f.registry.forHost).toBe(f.originalForHost);
  expect(f.registry.forHost("local")).toBe(f.nativeRpc);
  expect(f.connection.client.rpc).toBe(f.rpc);
});

it("prepares the first external message before startup without loaded conversation metadata", async () => {
  const f = fixture();
  f.metadata.clear();
  const input = {
    input: [{ type: "image", url: "data:image/png;base64,aGVsbG8=" }],
    collaborationMode: { mode: "default", settings: { model: "gpt-native" } },
  };
  const options = { clientThreadId: "client-new-thread:external", onSettled: vi.fn() };
  await f.connection.client.rpc.startConversation(input, options);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.rpc.getConversation).not.toHaveBeenCalled();
  expect(f.rpc.startConversation).toHaveBeenCalledExactlyOnceWith(
    {
      ...input,
      collaborationMode: {
        ...input.collaborationMode,
        settings: { model: "codexhost/grok-native" },
      },
    },
    options,
  );
  expect(input.collaborationMode.settings.model).toBe("gpt-native");
  f.hook.dispose();
});

it("does not borrow another draft's external route for a new official chat", async () => {
  const f = fixture();
  const input = {
    input: [{ type: "image", url: "data:image/png;base64,aGVsbG8=" }],
    collaborationMode: { settings: { model: "gpt-native" } },
  };
  const options = { clientThreadId: "client-new-thread:official" };
  await f.connection.client.rpc.startConversation(input, options);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.rpc.startConversation).toHaveBeenCalledExactlyOnceWith(input, options);
  f.hook.dispose();
});

it.each(["sendMessage", "sendQueuedMessageNow"] as const)(
  "composes async native preparation for %s before admission",
  async (method) => {
    const f = fixture();
    const nativeReady = Promise.withResolvers<{ input: string[] }>();
    const callback = vi.fn(() => nativeReady.promise);
    const coordinator = await f.connection.client.rpc.getTurnCoordinator();
    const pending =
      method === "sendMessage"
        ? coordinator.sendMessage({ conversationId: "thread" }, callback, "tail")
        : coordinator.sendQueuedMessageNow(
            "thread",
            "queued-id",
            { sendNow: true },
            callback,
            "tail",
          );
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    nativeReady.resolve({ input: ["image"] });
    await expect(pending).resolves.toBe(method === "sendMessage" ? "sent" : "queued");
    expect(callback.mock.calls[0]).toHaveLength(2);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.prepare.mock.calls[0]?.[1]).toMatchObject({
      hostId: "local",
      threadId: "thread",
      manager: f.rpc,
    });
    expect(f.dispatched).toHaveBeenCalledExactlyOnceWith(
      { input: ["image"], completed: true },
      "tail",
    );
    f.hook.dispose();
  },
);

it.each(["openai", "unknown"])("leaves %s ownership and callbacks unchanged", async (provider) => {
  const f = fixture(provider);
  const result = {};
  const callback = vi.fn(async () => result);
  const coordinator = await f.connection.client.rpc.getTurnCoordinator();
  await coordinator.sendMessage({ conversationId: "thread" }, callback);
  expect(f.native.sendMessage.mock.calls[0]?.[1]).toBe(callback);
  expect(f.dispatched).toHaveBeenCalledWith(result);
  expect(f.prepare).not.toHaveBeenCalled();
  f.hook.dispose();
});

it("verifies native ownership again and refuses ambiguous loaded metadata", async () => {
  const f = fixture();
  f.rpc.getConversation.mockResolvedValueOnce({ id: "different", modelProvider: "codexhost" });
  const callback = vi.fn(async () => ({}));
  const coordinator = await f.connection.client.rpc.getTurnCoordinator();
  await coordinator.sendMessage({ conversationId: "thread" }, callback);
  expect(f.prepare).not.toHaveBeenCalled();
  f.metadata.set("other", {
    value: {
      get: () => ({ conversationId: "thread", hostId: "remote", modelProvider: "codexhost" }),
    },
  });
  await coordinator.sendMessage({ conversationId: "thread" }, callback);
  expect(f.native.sendMessage.mock.calls[1]?.[1]).toBe(callback);
  f.hook.dispose();
});

it("releases native preparation on failure without admission or retry", async () => {
  const f = fixture();
  const dispose = vi.fn();
  const value = Object.defineProperty({}, Symbol.dispose, { value: dispose });
  const callback = vi.fn(async () => value);
  f.prepare.mockRejectedValueOnce(new Error("storage failed"));
  const coordinator = await f.connection.client.rpc.getTurnCoordinator();
  await expect(coordinator.sendMessage({ conversationId: "thread" }, callback)).rejects.toThrow(
    "storage failed",
  );
  expect(dispose).toHaveBeenCalledOnce();
  expect(f.dispatched).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledOnce();
  f.hook.dispose();
});

it("rejects stale async preparation and restores only the descriptor it owns", async () => {
  const f = fixture();
  const callbackReady = Promise.withResolvers<object>();
  const coordinator = await f.connection.client.rpc.getTurnCoordinator();
  const pending = coordinator.sendMessage(
    { conversationId: "thread" },
    () => callbackReady.promise,
  );
  const rejected = expect(pending).rejects.toThrow("no longer available");
  f.retire();
  callbackReady.resolve({});
  await rejected;
  expect(f.dispatched).not.toHaveBeenCalled();
  f.hook.refresh();
  expect(f.connection.client.rpc).toBe(f.rpc);
  const replacement = f.replaceConnection();
  f.hook.refresh();
  expect(replacement.client.rpc).not.toBe(f.rpc);
  const newer = { ...f.rpc };
  replacement.client.rpc = newer;
  f.hook.dispose();
  expect(replacement.client.rpc).toBe(newer);
});

it("discovers a late app scope and restores exact original descriptors on disposal", () => {
  const f = fixture();
  f.hook.dispose();
  const descriptor = Object.getOwnPropertyDescriptor(f.connection.client, "rpc");
  f.setMounted(false);
  const hook = installRendererRpcSubmissionPreparation(f.root, f.prepare);
  expect(f.connection.client.rpc).toBe(f.rpc);
  f.setMounted(true);
  hook.refresh();
  expect(f.connection.client.rpc).not.toBe(f.rpc);
  hook.dispose();
  expect(Object.getOwnPropertyDescriptor(f.connection.client, "rpc")).toEqual(descriptor);
});
