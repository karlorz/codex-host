import {
  findRendererAppScopeStore,
  findRendererHostRpcFamily,
  rendererHostRpcUsesExternalQueue,
  type RendererHostRpcRoot,
  type RendererHostRpcStore,
} from "./renderer-host-rpc-discovery.js";

type Method = (...args: unknown[]) => unknown;
type NativeRpc = object & {
  getConversation(id: string): Promise<unknown>;
  getTurnCoordinator(): Promise<object>;
  createFileAttachment(input: {
    contents: { arrayBuffer(): Promise<ArrayBuffer> };
    label: string;
  }): Promise<unknown>;
  removePastedTextAttachment(path: string): Promise<unknown>;
};

export interface RendererRpcSubmissionContext {
  hostId: string;
  /** Native conversation ID, or the client draft ID before conversation creation. */
  threadId: string;
  manager: NativeRpc;
  isCurrent(): boolean;
}

export interface RendererRpcClientRegistry {
  forHost(hostId: string): unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readSignal(signal: unknown): unknown {
  try {
    return record(signal) && typeof signal.get === "function" ? signal.get() : null;
  } catch {
    return null;
  }
}

/** Compose with Desktop's async preparation callback before native admission. */
export function installRendererRpcSubmissionPreparation(
  root: RendererHostRpcRoot,
  prepare: (value: unknown, context: RendererRpcSubmissionContext) => Promise<unknown>,
  readDraftModel?: (hostId: string, draftId: string) => string | null,
  readRegistry?: () => RendererRpcClientRegistry | null,
) {
  const bindings = new Map<
    string,
    {
      client: Record<string, unknown>;
      signal: unknown;
      store: RendererHostRpcStore;
      proxy: object;
      rpc: NativeRpc;
      sourceRpc: unknown;
      release(): void;
    }
  >();
  let registryBinding: {
    registry: RendererRpcClientRegistry;
    original: RendererRpcClientRegistry["forHost"];
    wrapped: RendererRpcClientRegistry["forHost"];
    release(): void;
  } | null = null;
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    const store = findRendererAppScopeStore(root);
    const discovery = store && findRendererHostRpcFamily(store);
    const registry = readRegistry?.() ?? null;
    if (
      registry !== (registryBinding?.registry ?? null) ||
      (registryBinding && registryBinding.registry.forHost !== registryBinding.wrapped)
    ) {
      for (const binding of bindings.values()) binding.release();
      bindings.clear();
      registryBinding?.release();
      registryBinding = null;
      const descriptor = registry && Object.getOwnPropertyDescriptor(registry, "forHost");
      if (registry && descriptor?.writable && typeof descriptor.value === "function") {
        const original = descriptor.value as RendererRpcClientRegistry["forHost"];
        const wrapped = (hostId: string) => {
          refresh();
          return bindings.get(hostId)?.proxy ?? original.call(registry, hostId);
        };
        Object.defineProperty(registry, "forHost", { ...descriptor, value: wrapped });
        registryBinding = {
          registry,
          original,
          wrapped,
          release() {
            if (registry.forHost === wrapped)
              Object.defineProperty(registry, "forHost", descriptor);
          },
        };
      }
    }
    const currentRpc = (hostId: string, client: Record<string, unknown>) => {
      try {
        return registryBinding
          ? registryBinding.original.call(registryBinding.registry, hostId)
          : client.rpc;
      } catch {
        return null;
      }
    };
    for (const [hostId, binding] of bindings) {
      const signal = discovery?.family.get(hostId)?.value;
      const value = readSignal(signal);
      if (
        signal === binding.signal &&
        store === binding.store &&
        record(value) &&
        value.status === "ready" &&
        value.client === binding.client &&
        binding.client.rpc === (registryBinding ? binding.sourceRpc : binding.proxy) &&
        (!registryBinding || currentRpc(hostId, binding.client) === binding.rpc)
      )
        continue;
      binding.release();
      bindings.delete(hostId);
    }
    if (!discovery || !store) return;
    for (const [hostId, member] of discovery.family) {
      if (typeof hostId !== "string" || bindings.has(hostId)) continue;
      const signal = member.value;
      if (!record(signal) || typeof signal.get !== "function") continue;
      const readConnection = () => readSignal(signal);
      const value = readConnection();
      if (
        !record(value) ||
        value.status !== "ready" ||
        !record(value.client) ||
        value.client.hostId !== hostId
      )
        continue;
      const client = value.client;
      const descriptor = Object.getOwnPropertyDescriptor(client, "rpc");
      const original = currentRpc(hostId, client);
      if (!descriptor?.writable || (typeof original !== "function" && !record(original))) continue;
      const rpc = original as unknown as NativeRpc;
      const boundRegistry = registryBinding;
      const isCurrent = () => {
        const current = readConnection();
        return (
          !disposed &&
          discovery.family.get(hostId)?.value === signal &&
          record(current) &&
          current.status === "ready" &&
          current.client === client &&
          client.rpc === (boundRegistry ? descriptor.value : proxy) &&
          registryBinding === boundRegistry &&
          (!boundRegistry ||
            (readRegistry?.() === boundRegistry.registry && currentRpc(hostId, client) === rpc))
        );
      };
      const assertCurrent = () => {
        if (!isCurrent()) throw new Error("Image attachment connection is no longer available");
      };
      const proxy: object = new Proxy(rpc, {
        get(target, property) {
          if (property === "startConversation") {
            return (input: unknown, options: unknown, ...rest: unknown[]) => {
              const start = Reflect.get(target, property, target) as Method;
              const mode =
                record(input) && record(input.collaborationMode) ? input.collaborationMode : null;
              const settings = mode && record(mode.settings) ? mode.settings : null;
              const draftId =
                record(options) && typeof options.clientThreadId === "string"
                  ? options.clientThreadId
                  : "";
              const explicit = settings?.model;
              const model =
                typeof explicit === "string" && explicit.startsWith("codexhost/")
                  ? explicit
                  : draftId.startsWith("client-new-thread:")
                    ? readDraftModel?.(hostId, draftId)
                    : null;
              if (
                !record(input) ||
                !Array.isArray(input.input) ||
                !mode ||
                !settings ||
                !model?.startsWith("codexhost/") ||
                !input.input.some(
                  (item) => record(item) && (item.type === "image" || item.type === "localImage"),
                )
              )
                return Reflect.apply(start, target, [input, options, ...rest]);
              // Capture the exact draft's carrier before storage awaits. Another
              // Composer's later selection must not reroute this first message.
              const routed = {
                ...input,
                collaborationMode: { ...mode, settings: { ...settings, model } },
              };
              return (async () => {
                assertCurrent();
                const result = await prepare(
                  { steer: routed },
                  { hostId, threadId: draftId, manager: rpc, isCurrent },
                );
                assertCurrent();
                if (!record(result) || !record(result.steer))
                  throw new Error("First message image preparation returned invalid input");
                return Reflect.apply(start, target, [result.steer, options, ...rest]);
              })();
            };
          }
          if (property !== "getTurnCoordinator") return Reflect.get(target, property, target);
          return async (...coordinatorArgs: unknown[]) => {
            assertCurrent();
            const coordinator = await Reflect.apply(
              target.getTurnCoordinator,
              target,
              coordinatorArgs,
            );
            assertCurrent();
            return new Proxy(coordinator, {
              get(owner, key) {
                const method: unknown = Reflect.get(owner, key, owner);
                if (
                  (key !== "sendMessage" && key !== "sendQueuedMessageNow") ||
                  typeof method !== "function"
                )
                  return typeof method === "function"
                    ? (...args: unknown[]) => Reflect.apply(method, owner, args)
                    : method;
                return (...callArgs: unknown[]) => {
                  const callbackIndex = key === "sendMessage" ? 1 : 3;
                  const nativePrepare = callArgs[callbackIndex];
                  const submission = callArgs[0];
                  const threadId =
                    key === "sendMessage"
                      ? record(submission)
                        ? submission.conversationId
                        : null
                      : submission;
                  if (
                    typeof threadId !== "string" ||
                    typeof nativePrepare !== "function" ||
                    !rendererHostRpcUsesExternalQueue(store, threadId)
                  )
                    return Reflect.apply(method, owner, callArgs);
                  callArgs[callbackIndex] = async (...args: unknown[]) => {
                    assertCurrent();
                    const result: unknown = await (nativePrepare as Method)(...args);
                    try {
                      assertCurrent();
                      const conversation = await rpc.getConversation(threadId);
                      assertCurrent();
                      if (
                        !record(conversation) ||
                        conversation.id !== threadId ||
                        conversation.modelProvider !== "codexhost"
                      )
                        return result;
                      const prepared = await prepare(result, {
                        hostId,
                        threadId,
                        manager: rpc,
                        isCurrent,
                      });
                      assertCurrent();
                      return prepared;
                    } catch (error) {
                      // Desktop registers disposal after this callback returns. A rejected
                      // preparation must release the native context itself.
                      const dispose = record(result) ? Reflect.get(result, Symbol.dispose) : null;
                      if (typeof dispose === "function") {
                        try {
                          Reflect.apply(dispose, result, []);
                        } catch {
                          // Preserve the preparation error.
                        }
                      }
                      throw error;
                    }
                  };
                  return Reflect.apply(method, owner, callArgs);
                };
              },
            });
          };
        },
      });
      // Native registries retain aliases of the connection. Replacing their
      // source RPC would invalidate the very cache whose lookup we wrap.
      if (!boundRegistry) Object.defineProperty(client, "rpc", { ...descriptor, value: proxy });
      bindings.set(hostId, {
        client,
        signal,
        store,
        proxy,
        rpc,
        sourceRpc: descriptor.value,
        release() {
          if (!boundRegistry && client.rpc === proxy)
            Object.defineProperty(client, "rpc", descriptor);
        },
      });
    }
  };
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      for (const binding of bindings.values()) binding.release();
      bindings.clear();
      registryBinding?.release();
      registryBinding = null;
    },
  };
}
