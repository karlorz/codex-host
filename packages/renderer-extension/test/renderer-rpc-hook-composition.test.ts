import { expect, it, vi } from "vitest";
import { installRendererRpcSubmissionPreparation } from "@codexhost/desktop-control/renderer-bindings";
import { installRendererRpcSteering } from "../src/renderer-rpc-steering.js";

it.each(["submission-first", "steering-first"])("composes native RPC hooks (%s)", async (order) => {
  const nativePrepare = vi.fn(async (request: unknown, mode: string) => {
    void request;
    void mode;
    return { conversationId: "thread", steer: {} };
  });
  const sendMessage = vi.fn(async (request: unknown, prepare: typeof nativePrepare) =>
    prepare(request, "start"),
  );
  const rpc = {
    getTurnCoordinator: () => ({ sendMessage }),
    getThreadExecutionState: async () => null,
    getConversation: async () => ({ id: "thread", modelProvider: "codexhost" }),
  };
  const registry = {
    forHost: (hostId: string): unknown => {
      void hostId;
      return rpc;
    },
  };
  const nativeForHost = registry.forHost;
  const connection = { status: "ready", client: { hostId: "local", rpc } };
  const store = {
    familyBindings: new Map<unknown, Map<string, { value: { get(): unknown } }>>([
      [{ kind: "signal-family" }, new Map([["local", { value: { get: () => connection } }]])],
      [
        { kind: "signal-family" },
        new Map([
          [
            "thread",
            {
              value: {
                get: () => ({
                  conversationId: "thread",
                  hostId: "local",
                  modelProvider: "codexhost",
                }),
              },
            },
          ],
        ]),
      ],
    ]),
  };
  const scope = { node: store, chain: [], scope: {}, get() {}, set() {}, watch() {} };
  const container = {
    __reactContainer$test: { memoizedState: { memoizedState: { current: scope }, next: null } },
  };
  let scopeReads = 0;
  const root = {
    // Bound the failing implementation's recursion so the regression cannot peg the test runner.
    getElementById: () => (++scopeReads > 30 ? null : container),
  };
  const prepare = vi.fn(async (value: unknown) => ({ ...(value as object), prepared: true }));
  let releaseSteering = order === "steering-first" ? installRendererRpcSteering(registry) : null;
  const submission = installRendererRpcSubmissionPreparation(
    root,
    prepare,
    undefined,
    () => registry,
  );
  releaseSteering ??= installRendererRpcSteering(registry);
  expect(releaseSteering).not.toBeNull();
  const composed = registry.forHost;
  try {
    for (let tick = 0; tick < 3; tick += 1) submission.refresh();
    expect(scopeReads).toBeLessThan(15);
    expect(registry.forHost).toBe(composed);
    const manager = registry.forHost("local") as typeof rpc;
    const coordinator = await manager.getTurnCoordinator();
    await coordinator.sendMessage({ conversationId: "thread" }, nativePrepare);
    expect(nativePrepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    // Removing an inner hook must retain the outer hook and its native connection.
    releaseSteering?.();
    submission.refresh();
    const remaining = registry.forHost("local") as typeof rpc;
    await (
      await remaining.getTurnCoordinator()
    ).sendMessage({ conversationId: "thread" }, nativePrepare);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(nativePrepare).toHaveBeenCalledTimes(2);
  } finally {
    releaseSteering?.();
    submission.dispose();
  }
  expect(registry.forHost).toBe(nativeForHost);
});
