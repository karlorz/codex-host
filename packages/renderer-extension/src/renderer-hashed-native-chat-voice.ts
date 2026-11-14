import type { CpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-config.js";
import { isolatedVoicePathEnabled } from "./renderer-voice-evidence.js";
import {
  HASHED_NATIVE_CHAT_PREWARM_ASSET,
  HASHED_NATIVE_CHAT_ROLES,
  HASHED_NATIVE_CHAT_START_ASSET,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
  NATIVE_CHAT_VOICE_CHUNKS,
  hashedVoiceCandidateOwner,
  hashedVoiceProfileSupported,
} from "./renderer-voice-profiles.js";

export {
  HASHED_NATIVE_CHAT_PREWARM_ASSET,
  HASHED_NATIVE_CHAT_ROLES,
  HASHED_NATIVE_CHAT_START_ASSET,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
};

type RecordValue = Record<string, unknown>;

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

function scopeBrand(value: unknown, brand: string): boolean {
  return object(value) && value.__scopeBrand === brand;
}

interface WebpackModule {
  exports?: unknown;
  error?: unknown;
}

interface WebpackFactory {
  (this: unknown, module?: WebpackModule, exports?: unknown, require?: unknown): unknown;
}

export interface HashedWebpackRequire {
  (id: string): unknown;
  e?: (chunk: number) => Promise<unknown>;
  m?: Record<string, WebpackFactory | undefined>;
  c?: Record<string, WebpackModule | undefined>;
}

function webpackRequireFrom(runtime: unknown): HashedWebpackRequire | undefined {
  if (!object(runtime) || typeof runtime.__webpack_require__ !== "function") return;
  return runtime.__webpack_require__ as HashedWebpackRequire;
}

function peekHashedExport(req: HashedWebpackRequire, id: string): unknown {
  const cached = req.c?.[id];
  return cached?.error === undefined ? cached?.exports : undefined;
}

function unpoisonEmptyWebpackModule(req: HashedWebpackRequire, id: string): void {
  const cache = req.c;
  const cached = cache?.[id];
  if (!cache || !cached) return;
  const exports = cached.exports;
  if (cached.error === undefined && object(exports) && Object.keys(exports).length > 0) return;
  try {
    Reflect.deleteProperty(cache, id);
  } catch {
    /* Empty Instant Connect cache entries cannot START Chat voice. */
  }
}

function installHashedWebpackModules(req: HashedWebpackRequire, modules: unknown): void {
  if (!req.m || !object(modules)) return;
  for (const [id, factory] of Object.entries(modules)) {
    if (typeof factory !== "function" || typeof req.m[id] === "function") continue;
    req.m[id] = factory as WebpackFactory;
  }
}

function requireHashedExport(
  req: HashedWebpackRequire,
  id: string,
  usable: (value: unknown) => boolean,
): unknown {
  const peeked = peekHashedExport(req, id);
  if (usable(peeked)) return peeked;
  unpoisonEmptyWebpackModule(req, id);
  let value: unknown;
  try {
    value = req(id);
  } catch {
    unpoisonEmptyWebpackModule(req, id);
    return undefined;
  }
  return usable(value) ? value : undefined;
}

export function hashedNativeChatVoiceSupported(
  config: CpaLiveVoiceHookConfig | { desktopVersion?: string; desktopPlatform?: string },
): boolean {
  if (hashedVoiceProfileSupported(config)) return true;
  if (!hashedVoiceCandidateOwner(config) || !("isolatedQualification" in config)) return false;
  return isolatedVoicePathEnabled(config as CpaLiveVoiceHookConfig, "chat");
}

export async function resolveHashedWebpackRequire(
  importModule: (url: string) => Promise<RecordValue>,
): Promise<HashedWebpackRequire | undefined> {
  const runtime = await importModule(`app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}`);
  return webpackRequireFrom(runtime);
}

/** Map 26.1106 hashed Instant Connect onto the native Chat hook contract. */
export async function loadHashedNativeChatVoiceModules(
  importModule: (url: string) => Promise<RecordValue>,
): Promise<{
  initial: RecordValue;
  shared: RecordValue;
  start: RecordValue;
  prewarm: RecordValue;
}> {
  const req = await resolveHashedWebpackRequire(importModule);
  if (!req) throw new Error("hashed webpack require missing");
  const loadChunk = req.e;
  if (typeof loadChunk !== "function") throw new Error("native Chat voice chunk loader missing");
  // A failed require of an unloaded dependency leaves an empty cached module.
  // Repair only entries whose missing factory is supplied by the native loader.
  const missingFactories = Object.entries(req.c ?? {})
    .filter(
      ([id, module]) =>
        !req.m?.[id] && object(module?.exports) && Object.keys(module.exports).length === 0,
    )
    .map(([id]) => id);
  await Promise.all(NATIVE_CHAT_VOICE_CHUNKS.map((chunk) => loadChunk.call(req, chunk)));
  // Rspack stores failures even after exports have been published. Requiring a
  // failed START/prewarm module rethrows that cached failure until it is removed.
  for (const id of new Set([
    ...missingFactories,
    HASHED_NATIVE_CHAT_ROLES.startModuleId,
    HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
  ])) {
    const cached = req.c?.[id];
    if (
      typeof req.m?.[id] === "function" &&
      (cached?.error !== undefined || missingFactories.includes(id))
    ) {
      unpoisonEmptyWebpackModule(req, id);
    }
  }
  const [startChunk, prewarmChunk] = await Promise.all([
    importModule(`app://-/assets/async/${HASHED_NATIVE_CHAT_START_ASSET}`),
    importModule(`app://-/assets/async/${HASHED_NATIVE_CHAT_PREWARM_ASSET}`),
  ]);
  installHashedWebpackModules(req, startChunk.__webpack_modules__);
  installHashedWebpackModules(req, prewarmChunk.__webpack_modules__);
  const roles = HASHED_NATIVE_CHAT_ROLES;
  const startExports = requireHashedExport(
    req,
    roles.startModuleId,
    (value) => object(value) && typeof value[roles.startInitializeExport] === "function",
  );
  const prewarmExports = requireHashedExport(
    req,
    roles.prewarmModuleId,
    (value) => object(value) && typeof value[roles.prewarmControllerExport] === "function",
  );
  const appScope = requireHashedExport(
    req,
    roles.appScopeModuleId,
    (value) => object(value) && scopeBrand(value[roles.appScopeExport], "AppScope"),
  );
  const routeScope = requireHashedExport(
    req,
    roles.routeScopeModuleId,
    (value) => object(value) && scopeBrand(value[roles.routeScopeExport], "RouteScope"),
  );
  const composerScope = requireHashedExport(
    req,
    roles.composerScopeModuleId,
    (value) => object(value) && scopeBrand(value[roles.composerScopeExport], "ComposerScope"),
  );
  const store = requireHashedExport(
    req,
    roles.storeModuleId,
    (value) => object(value) && typeof value[roles.storeExport] === "function",
  );
  const runtime = requireHashedExport(
    req,
    roles.runtimeModuleId,
    (value) =>
      object(value) &&
      value[roles.runtimeEnableExport] != null &&
      typeof value[roles.runtimeLoaderExport] === "function",
  );
  const react = requireHashedExport(
    req,
    roles.reactModuleId,
    (value) => object(value) && typeof value.createElement === "function",
  );
  const reactDom = requireHashedExport(
    req,
    roles.reactDomModuleId,
    (value) => object(value) && typeof value.createRoot === "function",
  );
  const conversation = requireHashedExport(
    req,
    roles.conversationModuleId,
    (value) =>
      object(value) &&
      value[roles.backendConversationExport] != null &&
      value[roles.transcriptMappingExport] != null &&
      value[roles.currentNodeExport] != null,
  );
  const location = requireHashedExport(
    req,
    roles.locationModuleId,
    (value) => object(value) && value[roles.locationExport] != null,
  );
  const navigation = requireHashedExport(
    req,
    roles.navigationModuleId,
    (value) => object(value) && typeof value[roles.navigationExport] === "function",
  );
  const conversationPath = requireHashedExport(
    req,
    roles.conversationPathModuleId,
    (value) => object(value) && typeof value[roles.conversationPathExport] === "function",
  );
  if (
    !object(startExports) ||
    !object(prewarmExports) ||
    !object(appScope) ||
    !object(routeScope) ||
    !object(composerScope) ||
    !object(store) ||
    !object(runtime) ||
    !object(react) ||
    !object(reactDom)
  )
    throw new Error("hashed Instant Connect exports missing");
  const nativeNavigate = object(navigation)
    ? (navigation[roles.navigationExport] as (...args: unknown[]) => unknown)
    : undefined;
  const nativeConversationPath = object(conversationPath)
    ? conversationPath[roles.conversationPathExport]
    : undefined;
  const initializeVoiceSession = startExports[
    roles.startInitializeExport
  ] as () => Promise<unknown>;
  let skipIntroduction = false;
  const startVoice = async (
    scope: unknown,
    props: unknown,
    _meta: unknown,
    signal: unknown,
  ): Promise<void> => {
    const conversationId =
      object(props) && typeof props.conversationId === "string" ? props.conversationId : undefined;
    if (!conversationId) throw new Error();
    // The native loader mounts VoiceRoom through the app root before commands
    // are queued, and preserves authentication, availability and navigation gates.
    const session = await (
      runtime[roles.runtimeLoaderExport] as (...args: unknown[]) => Promise<unknown>
    )(scope, conversationId, { event_source: "composer" }, signal);
    if (!object(session)) throw new Error();
    const nux =
      typeof session.getVoiceNuxMode === "function"
        ? await session.getVoiceNuxMode(scope)
        : undefined;
    const cancel = () => !(signal instanceof AbortSignal) || !signal.aborted;
    try {
      const state =
        typeof store[roles.storeExport] === "function"
          ? (
              (store[roles.storeExport] as (scope: unknown) => unknown)(scope) as {
                getState(): {
                  isVoiceModeActive?: boolean;
                  server?: { connectionState?: unknown };
                };
              }
            ).getState()
          : undefined;
      if (
        state?.isVoiceModeActive === true &&
        state.server?.connectionState !== "connected" &&
        typeof session.dispatchVoiceCommand === "function"
      )
        await session.dispatchVoiceCommand(
          scope,
          { type: "STOP", reason: "failed" },
          { prepend: true },
        );
    } catch {
      /* A stuck Instant Connect flag must not block the next Start Voice click. */
    }
    // Leftover Instant Connect intent makes startVoiceMode's ip.ac fail, so START
    // returns to Chat home. Native tm finally clears that intent when START does not stick.
    if (typeof session.clearSessionCreate === "function")
      session.clearSessionCreate(scope, { resetTimings: true });
    // Native composer: wingman NUX uses tm(); after hasSeenAdvancedVoice it dispatches START.
    // Passing no intro options makes tm show Meet Voice every click.
    if (nux === "wingman" && !skipIntroduction) {
      if (typeof session.startVoiceWithIntroduction !== "function") throw new Error();
      const started = await session.startVoiceWithIntroduction(scope, props, cancel, {
        kind: "full",
        showIntroduction: true,
      });
      if (started === false) throw new Error();
      skipIntroduction = true;
      return;
    }
    if ((nux !== "none" && nux !== "wingman") || typeof session.dispatchVoiceCommand !== "function")
      throw new Error();
    const overrides =
      typeof session.getConversationVoiceStartOverrides === "function"
        ? session.getConversationVoiceStartOverrides(scope, conversationId)
        : undefined;
    await session.dispatchVoiceCommand(scope, {
      type: "START",
      args: {
        conversationId,
        eventSource: "composer",
        ...(object(overrides) ? overrides : {}),
      },
    });
  };
  return {
    initial: {
      MOr: routeScope[roles.routeScopeExport],
      CDr: composerScope[roles.composerScopeExport],
      B1n: object(conversation) ? conversation[roles.backendConversationExport] : {},
      SPn: store[roles.storeExport],
      aT: runtime[roles.runtimeEnableExport],
      ...(object(location) ? { Ycr: location[roles.locationExport] } : {}),
      ...(object(conversation)
        ? {
            n0n: conversation[roles.transcriptMappingExport],
            Y1n: conversation[roles.currentNodeExport],
          }
        : {}),
      ...(typeof nativeNavigate === "function"
        ? {
            Nir: (scope: unknown, path: unknown) =>
              Reflect.apply(nativeNavigate, undefined, [
                scope,
                typeof path === "string" ? { pathname: path } : path,
              ]),
          }
        : {}),
    },
    shared: {
      Qst: appScope[roles.appScopeExport],
      FBt: () => react,
      PNt: () => reactDom,
      ...(typeof nativeConversationPath === "function" ? { Vot: nativeConversationPath } : {}),
    },
    start: {
      t() {},
      n: startVoice,
    },
    prewarm: {
      VoiceInstantConnectCacheController: prewarmExports[roles.prewarmControllerExport],
      props: { loadVoiceSession: initializeVoiceSession },
    },
  };
}
