import { selectVoiceAssets } from "./renderer-voice-assets.js";
import {
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  nativeChatVoiceKind,
  type NativeChatVoiceKind,
} from "./renderer-voice-profiles.js";
import {
  NATIVE_CHAT_VOICE_ASSETS,
  loadNativeChatVoiceModules,
} from "./renderer-native-chat-voice-assets.js";
import { loadHashedNativeChatVoiceModules } from "./renderer-hashed-native-chat-voice.js";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import type { ChatVoiceScope } from "./renderer-native-chat-voice.js";
import { observeNativeChatVoiceState } from "./renderer-native-chat-voice-state.js";

type NativeChatVoiceBinding = {
  composer: Element;
  appNode: object;
  props: RecordValue & { conversationId: string };
  scope: ChatVoiceScope;
  context: unknown;
  composerContext: { context: unknown; chain: Map<unknown, unknown> };
  backendConversationId: string | undefined;
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object";

export const NATIVE_CHAT_CONNECTED_TIMEOUT_MS = 8_000;
export const NATIVE_CHAT_START_TIMEOUT_MS = 8_000;
export const NATIVE_CHAT_PREPARE_FAILURE_BUDGET = 8;

export type NativeChatVoiceModules = {
  initial: RecordValue;
  shared: RecordValue;
  start: RecordValue;
  prewarm: RecordValue;
};

export type NativeChatVoiceStartCategory =
  | "connected"
  | "start-acknowledged"
  | "timeout"
  | "mismatch"
  | "duplicate"
  | "native-error"
  | "unavailable"
  | "cancelled";

export type NativeChatVoiceStartObservation = {
  acknowledged: boolean;
  connected: boolean;
  conversationMatched: boolean;
  productMatched: boolean;
  category: NativeChatVoiceStartCategory;
};

export type NativeChatVoiceObservedState = {
  voiceModeActive: boolean;
  connected: boolean;
  sessionStarted: boolean;
  conversationMatched: boolean;
  isWorkMode: boolean | undefined;
  conversationId: unknown;
};

export type NativeChatVoiceMount = {
  node: unknown;
  render(binding: NativeChatVoiceBinding): void;
  dispose(): void;
};

export function createNativeChatPrepareBudget(maxFailures = NATIVE_CHAT_PREPARE_FAILURE_BUDGET): {
  allow(key: string): boolean;
  fail(key: string): void;
  reset(key?: string): void;
} {
  let current = "";
  let failures = 0;
  return {
    allow(key: string) {
      if (key !== current) {
        current = key;
        failures = 0;
      }
      return failures < maxFailures;
    },
    fail(key: string) {
      if (key !== current) {
        current = key;
        failures = 0;
      }
      failures += 1;
    },
    reset(key?: string) {
      current = key ?? "";
      failures = 0;
    },
  };
}

export function selectNativeChatVoiceAdapter(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): NativeChatVoiceKind | undefined {
  return nativeChatVoiceKind(config);
}

export async function loadNativeChatVoiceGraph(options: {
  adapter: NativeChatVoiceKind;
  names: readonly string[];
  config: { desktopVersion?: string; desktopPlatform?: string };
  importModule: (url: string) => Promise<RecordValue>;
}): Promise<NativeChatVoiceModules | undefined> {
  if (options.adapter === "hashed") {
    if (!options.names.some((name) => name.includes(HASHED_WEBPACK_VOICE_RUNTIME_ASSET))) {
      return undefined;
    }
    return loadHashedNativeChatVoiceModules(options.importModule);
  }
  const assets = selectVoiceAssets(
    NATIVE_CHAT_VOICE_ASSETS,
    options.names,
    options.config.desktopVersion,
    options.config.desktopPlatform,
  );
  if (!assets) return undefined;
  return loadNativeChatVoiceModules(assets, options.importModule);
}

export function hashedNativeChatGraphReady(names: readonly string[]): boolean {
  return names.some((name) => name.includes(HASHED_WEBPACK_VOICE_RUNTIME_ASSET));
}

export function readNativeChatVoiceObservedState(
  scope: NativeChatVoiceBinding["scope"],
  initial: RecordValue,
  binding?: NativeChatVoiceBinding,
): NativeChatVoiceObservedState | undefined {
  if (typeof initial.SPn !== "function") return undefined;
  try {
    const state = (
      Reflect.apply(initial.SPn, undefined, [scope]) as {
        getState(): {
          isVoiceModeActive?: boolean;
          isWorkMode?: boolean;
          conversationId?: unknown;
          hasVoiceSessionStarted?: boolean;
          server?: { connectionState?: unknown };
        };
      }
    ).getState();
    const connected = state.server?.connectionState === "connected";
    const conversationMatched =
      binding === undefined || state.conversationId === binding.props.conversationId;
    return {
      voiceModeActive: state.isVoiceModeActive === true,
      connected,
      sessionStarted: state.hasVoiceSessionStarted === true,
      conversationMatched,
      isWorkMode: typeof state.isWorkMode === "boolean" ? state.isWorkMode : undefined,
      conversationId: state.conversationId,
    };
  } catch {
    return undefined;
  }
}

export function nativeChatVoiceSessionLive(
  state: NativeChatVoiceObservedState | undefined,
): boolean {
  return (
    state?.voiceModeActive === true && (state.sessionStarted === true || state.connected === true)
  );
}

export function nativeChatVoiceConnected(state: NativeChatVoiceObservedState | undefined): boolean {
  return (
    state?.voiceModeActive === true &&
    state.connected === true &&
    state.isWorkMode === false &&
    state.conversationMatched === true
  );
}

export function mountNativeChatVoiceRuntime(options: {
  adapter: NativeChatVoiceKind;
  binding: NativeChatVoiceBinding;
  modules: NativeChatVoiceModules;
  document: Document;
  onRenderFailed?: () => void;
}): NativeChatVoiceMount {
  const { adapter, binding, modules, document: doc } = options;
  const { scope } = binding;
  const initial = modules.initial;
  const stopObserving = observeNativeChatVoiceState(scope, initial);
  const previous = scope.get(initial.aT);
  if (adapter === "hashed") {
    const mounted: NativeChatVoiceMount = {
      node: binding.appNode,
      render() {},
      dispose() {
        stopObserving();
        if (scope.get(initial.aT) === true) scope.set(initial.aT, previous);
        chatVoiceDebug("native-chat-unbound");
      },
    };
    scope.set(initial.aT, true);
    chatVoiceDebug("native-chat-bound", {
      hashed: true,
      hasConversationId: binding.backendConversationId !== undefined,
    });
    return mounted;
  }
  const container = doc.createElement("div");
  container.setAttribute("data-codexhost-chat-voice-prewarm", "");
  doc.body.append(container);
  const react = Reflect.apply(modules.shared.FBt as () => unknown, undefined, []) as {
    createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
  };
  const reactDom = Reflect.apply(modules.shared.PNt as () => unknown, undefined, []) as {
    createRoot(
      container: Element,
      options: { onUncaughtError(): void },
    ): { render(element: unknown): void; unmount(): void };
  };
  const root = reactDom.createRoot(container, {
    onUncaughtError() {
      options.onRenderFailed?.();
    },
  });
  let appChain: Map<unknown, unknown> | undefined;
  let composerChain: Map<unknown, unknown> | undefined;
  const mounted: NativeChatVoiceMount = {
    node: binding.appNode,
    render(next) {
      if (appChain === next.scope.chain && composerChain === next.composerContext.chain) return;
      appChain = next.scope.chain;
      composerChain = next.composerContext.chain;
      root.render(
        react.createElement(
          next.context,
          { value: appChain },
          react.createElement(
            next.composerContext.context,
            { value: composerChain },
            react.createElement(
              modules.prewarm.VoiceInstantConnectCacheController,
              record(modules.prewarm.props) ? modules.prewarm.props : null,
            ),
          ),
        ),
      );
    },
    dispose() {
      stopObserving();
      root.unmount();
      container.remove();
      if (scope.get(initial.aT) === true) scope.set(initial.aT, previous);
      chatVoiceDebug("native-chat-unbound");
    },
  };
  scope.set(initial.aT, true);
  chatVoiceDebug("native-chat-bound", {
    hashed: false,
    hasConversationId: binding.backendConversationId !== undefined,
  });
  return mounted;
}

function ownedNativeAbort(parent: AbortSignal): AbortController {
  const owned = new AbortController();
  if (parent.aborted) {
    owned.abort(parent.reason);
    return owned;
  }
  parent.addEventListener(
    "abort",
    () => {
      owned.abort(parent.reason);
    },
    { once: true },
  );
  return owned;
}

export async function startNativeChatVoiceSession(options: {
  binding: NativeChatVoiceBinding;
  modules: NativeChatVoiceModules;
  signal: AbortSignal;
  starting: boolean;
}): Promise<NativeChatVoiceStartObservation> {
  if (options.starting) {
    return {
      acknowledged: false,
      connected: false,
      conversationMatched: false,
      productMatched: false,
      category: "duplicate",
    };
  }
  const { binding, modules, signal } = options;
  const nativeAbort = ownedNativeAbort(signal);
  const nativeStart = Promise.resolve(
    Reflect.apply(modules.start.n as (...args: unknown[]) => unknown, undefined, [
      binding.scope,
      binding.props,
      { event_source: "composer" },
      nativeAbort.signal,
    ]),
  );
  const settled = await awaitBoundNative(
    nativeStart,
    nativeAbort.signal,
    NATIVE_CHAT_START_TIMEOUT_MS,
  );
  if (settled.status === "timeout" && !nativeAbort.signal.aborted) {
    nativeAbort.abort();
  }
  if (settled.status !== "resolved") {
    chatVoiceDebug("native-chat-start-failed", { status: settled.status });
    return {
      acknowledged: false,
      connected: false,
      conversationMatched: false,
      productMatched: false,
      category:
        settled.status === "timeout"
          ? "timeout"
          : settled.status === "cancelled" || signal.aborted
            ? "cancelled"
            : "native-error",
    };
  }
  chatVoiceDebug("native-chat-start-returned");
  const state = readNativeChatVoiceObservedState(binding.scope, modules.initial, binding);
  const connected = nativeChatVoiceConnected(state);
  const observation: NativeChatVoiceStartObservation = {
    acknowledged: true,
    connected,
    conversationMatched: state?.conversationMatched === true,
    productMatched: state?.isWorkMode === false,
    category: connected ? "connected" : "start-acknowledged",
  };
  chatVoiceDebug("native-chat-start-observation", {
    acknowledged: observation.acknowledged,
    connected: observation.connected,
    conversationMatched: observation.conversationMatched,
    productMatched: observation.productMatched,
  });
  return observation;
}

export function classifyNativeChatVoiceStart(
  observation: NativeChatVoiceStartObservation,
): NativeChatVoiceStartCategory {
  if (
    observation.category === "duplicate" ||
    observation.category === "native-error" ||
    observation.category === "cancelled" ||
    observation.category === "timeout"
  ) {
    return observation.category;
  }
  if (!observation.acknowledged) return "unavailable";
  if (observation.connected && observation.conversationMatched && observation.productMatched) {
    return "connected";
  }
  return observation.category === "mismatch" ? "mismatch" : "start-acknowledged";
}

export function awaitBoundNative<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<
  | { status: "resolved"; value: T }
  | { status: "timeout" }
  | { status: "cancelled" }
  | { status: "rejected"; error: unknown }
> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ status: "cancelled" });
      return;
    }
    let settled = false;
    const started = now();
    const finish = (
      result:
        | { status: "resolved"; value: T }
        | { status: "timeout" }
        | { status: "cancelled" }
        | { status: "rejected"; error: unknown },
    ) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(result);
    };
    const onAbort = () => finish({ status: "cancelled" });
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => finish({ status: "timeout" }),
      Math.max(0, timeoutMs - (now() - started)),
    );
    work.then(
      (value) => finish({ status: "resolved", value }),
      (error) => finish(signal.aborted ? { status: "cancelled" } : { status: "rejected", error }),
    );
  });
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** START acknowledgment is not a connected call. Poll native Chat state until
 * connected, identity mismatch, abort, or the bounded timeout.
 */
export async function observeNativeChatVoiceConnection(options: {
  read(): NativeChatVoiceObservedState | undefined;
  signal: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<"connected" | "timeout" | "mismatch" | "cancelled"> {
  const timeoutMs = options.timeoutMs ?? NATIVE_CHAT_CONNECTED_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitWithAbort;
  const started = now();
  while (!options.signal.aborted) {
    const state = options.read();
    if (nativeChatVoiceConnected(state)) return "connected";
    if (state && (state.isWorkMode === true || state.conversationMatched === false)) {
      return "mismatch";
    }
    if (now() - started >= timeoutMs) return "timeout";
    try {
      await wait(100, options.signal);
    } catch {
      return options.signal.aborted ? "cancelled" : "timeout";
    }
  }
  return "cancelled";
}
