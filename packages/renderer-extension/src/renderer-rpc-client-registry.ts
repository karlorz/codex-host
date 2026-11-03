import {
  findRendererAppScopeStore,
  type RendererRpcClientRegistry,
} from "@codexhost/desktop-control/renderer-bindings";
import { loadCodexNativeServices } from "./codex-native-services.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Read only already-bound native signals; discovery never initializes an atom. */
export function rendererRpcClientRegistryReader(owner: Window, onReady: () => void) {
  let definition: object | null = null;
  let pending = false;
  let disposed = false;
  const boundValue = (
    candidate: unknown,
    root: ReturnType<typeof findRendererAppScopeStore>,
  ): unknown => {
    if (!root || !record(candidate) || candidate.cache !== "signal") return null;
    const signals = Reflect.get(root, "signalBindings") as WeakMap<object, unknown> | undefined;
    const store = Reflect.get(root, "store") as { get(atom: unknown): unknown } | undefined;
    if (!signals?.has(candidate) || typeof store?.get !== "function") return null;
    try {
      return store.get(signals.get(candidate));
    } catch {
      return null;
    }
  };
  const registry = (value: unknown): value is RendererRpcClientRegistry =>
    record(value) &&
    typeof value.forHost === "function" &&
    typeof value.collectAppStateSnapshot === "function" &&
    typeof value.getReviewPaneSnapshotMetrics === "function" &&
    typeof value.dispose === "function";
  return {
    read(): RendererRpcClientRegistry | null {
      if (disposed) return null;
      const root = findRendererAppScopeStore(owner.document);
      const value = definition && boundValue(definition, root);
      if (registry(value)) return value;
      if (!pending) {
        pending = true;
        void loadCodexNativeServices(owner, (value): value is object =>
          registry(boundValue(value, root)),
        )
          .then((value) => {
            if (!disposed && value) {
              definition = value;
              onReady();
            }
          })
          .catch(() => {
            /* A missing or ambiguous native registry stays unbound. */
          })
          .finally(() => {
            pending = false;
          });
      }
      return null;
    },
    dispose() {
      disposed = true;
      definition = null;
    },
  };
}
