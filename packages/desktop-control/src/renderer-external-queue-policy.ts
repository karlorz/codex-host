import type {
  findRendererAppScopeStore,
  rendererHostRpcUsesExternalQueue,
  RendererHostRpcRoot,
} from "./renderer-host-rpc-discovery.js";

interface QueuePolicyTarget {
  __codexhostExternalQueuePolicyV1?: { dispose(): void };
}

/**
 * Desktop's main-process coordinator is an RPC facade in the Renderer. Select
 * its native per-submission queue mode before it prepares or presents a steer.
 * Self-contained for injection; do not inspect prompts or decode Model names.
 */
export function installRendererExternalQueuePolicy(
  root: RendererHostRpcRoot,
  target: QueuePolicyTarget,
  dependencies: {
    findStore: typeof findRendererAppScopeStore;
    usesExternalQueue: typeof rendererHostRpcUsesExternalQueue;
    portPrototype: { postMessage(this: unknown, message: unknown, ...rest: unknown[]): unknown };
  },
): { dispose(): void } | null {
  if (target.__codexhostExternalQueuePolicyV1) return target.__codexhostExternalQueuePolicyV1;
  const store = dependencies.findStore(root);
  if (!store) return null;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  let disposed = false;
  const route = (message: unknown): unknown => {
    if (!Array.isArray(message) || message.length !== 2 || message[0] !== "push") return message;
    const expression: unknown = message[1];
    if (!Array.isArray(expression) || expression.length !== 4 || expression[0] !== "pipeline")
      return message;
    const [, importId, path, args] = expression as unknown[];
    if (
      !Array.isArray(path) ||
      path.length !== 1 ||
      path[0] !== "sendMessage" ||
      !Array.isArray(args)
    )
      return message;
    const input: unknown = args[0];
    if (
      !record(input) ||
      typeof input.conversationId !== "string" ||
      !record(input.message) ||
      !dependencies.usesExternalQueue(store, input.conversationId)
    )
      return message;
    // Regular queue mode still starts an idle Turn; queue-only would strand it.
    return [
      "push",
      ["pipeline", importId, path, [{ ...input, queueModeOverride: "queue" }, ...args.slice(1)]],
    ];
  };
  const port = dependencies.portPrototype;
  const original = port.postMessage;
  const postMessage = function (this: unknown, message: unknown, ...rest: unknown[]): unknown {
    return original.call(this, disposed ? message : route(message), ...rest);
  };
  port.postMessage = postMessage;
  const policy = {
    dispose() {
      disposed = true;
      if (port.postMessage === postMessage) port.postMessage = original;
      if (target.__codexhostExternalQueuePolicyV1 === policy)
        delete target.__codexhostExternalQueuePolicyV1;
    },
  };
  Object.defineProperty(target, "__codexhostExternalQueuePolicyV1", {
    configurable: true,
    value: policy,
  });
  return policy;
}
