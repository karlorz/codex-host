import {
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
} from "./renderer-hashed-webpack-voice.js";

export { HASHED_WEBPACK_VOICE_RUNTIME_ASSET, HASHED_WEBPACK_VOICE_VERSION };

/** Hashed Instant Connect START / VoiceRoom. */
export const HASHED_NATIVE_CHAT_START_ASSET = "530142.1e51e7f4b2.js";
/** Hashed VoiceInstantConnectCacheController. */
export const HASHED_NATIVE_CHAT_PREWARM_ASSET = "586788.c871bb9b7d.js";

type RecordValue = Record<string, unknown>;

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

function scopeBrand(value: unknown, brand: string): boolean {
  return object(value) && value.__scopeBrand === brand;
}

interface WebpackModule {
  exports?: unknown;
}

interface WebpackFactory {
  (this: unknown, module?: WebpackModule, exports?: unknown, require?: unknown): unknown;
}

export interface HashedWebpackRequire {
  (id: string): unknown;
  m?: Record<string, WebpackFactory | undefined>;
  c?: Record<string, WebpackModule | undefined>;
}

function webpackRequireFrom(runtime: unknown): HashedWebpackRequire | undefined {
  if (!object(runtime) || typeof runtime.__webpack_require__ !== "function") return;
  return runtime.__webpack_require__ as HashedWebpackRequire;
}

function unpoisonEmptyWebpackModule(req: HashedWebpackRequire, id: string): void {
  const cache = req.c;
  const cached = cache?.[id];
  if (!cache || !cached) return;
  const exports = cached.exports;
  if (object(exports) && Object.keys(exports).length > 0) return;
  try {
    Reflect.deleteProperty(cache, id);
  } catch {
    /* Empty Instant Connect cache entries cannot START Chat voice. */
  }
}

function installHashedWebpackModules(req: HashedWebpackRequire, modules: unknown): void {
  if (!req.m || !object(modules)) return;
  for (const [id, factory] of Object.entries(modules)) {
    if (typeof factory === "function") req.m[id] = factory as WebpackFactory;
  }
}

function requireHashedExport(
  req: HashedWebpackRequire,
  id: string,
  usable: (value: unknown) => boolean,
): unknown {
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

export function hashedNativeChatVoiceSupported(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): boolean {
  return (
    config.desktopVersion === HASHED_WEBPACK_VOICE_VERSION &&
    (config.desktopPlatform === undefined || config.desktopPlatform === "darwin")
  );
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
  if (!req) throw new Error();
  const [startChunk, prewarmChunk] = await Promise.all([
    importModule(`app://-/assets/async/${HASHED_NATIVE_CHAT_START_ASSET}`),
    importModule(`app://-/assets/async/${HASHED_NATIVE_CHAT_PREWARM_ASSET}`),
  ]);
  installHashedWebpackModules(req, startChunk.__webpack_modules__);
  installHashedWebpackModules(req, prewarmChunk.__webpack_modules__);
  const startExports = requireHashedExport(
    req,
    "j9r7",
    (value) => object(value) && typeof value.initializeVoiceSession === "function",
  );
  const prewarmExports = requireHashedExport(
    req,
    "oWM3",
    (value) => object(value) && typeof value.VoiceInstantConnectCacheController === "function",
  );
  const appScope = requireHashedExport(
    req,
    "OWtl",
    (value) => object(value) && scopeBrand(value.u, "AppScope"),
  );
  const routeScope = requireHashedExport(
    req,
    "Oj9r",
    (value) => object(value) && scopeBrand(value.GD, "RouteScope"),
  );
  const composerScope = requireHashedExport(
    req,
    "Sd8U",
    (value) => object(value) && scopeBrand(value.PR, "ComposerScope"),
  );
  const store = requireHashedExport(
    req,
    "bgok",
    (value) => object(value) && typeof value.MH === "function",
  );
  const flags = requireHashedExport(req, "hOYb", (value) => object(value) && value.H3 != null);
  const react = requireHashedExport(
    req,
    "zd8w",
    (value) => object(value) && typeof value.createElement === "function",
  );
  const reactDom = requireHashedExport(
    req,
    "CE87",
    (value) => object(value) && typeof value.createRoot === "function",
  );
  if (
    !object(startExports) ||
    !object(prewarmExports) ||
    !object(appScope) ||
    !object(routeScope) ||
    !object(composerScope) ||
    !object(store) ||
    !object(flags) ||
    !object(react) ||
    !object(reactDom)
  )
    throw new Error();
  const initializeVoiceSession = startExports.initializeVoiceSession as () => Promise<unknown>;
  let skipIntroduction = false;
  const startVoice = async (
    scope: unknown,
    props: unknown,
    _meta: unknown,
    signal: unknown,
  ): Promise<void> => {
    const session = await initializeVoiceSession();
    if (!object(session)) throw new Error();
    const conversationId =
      object(props) && typeof props.conversationId === "string" ? props.conversationId : undefined;
    if (!conversationId) throw new Error();
    const nux =
      typeof session.getVoiceNuxMode === "function"
        ? await session.getVoiceNuxMode(scope)
        : undefined;
    const cancel = () => !(signal instanceof AbortSignal) || !signal.aborted;
    try {
      const state =
        typeof store.MH === "function"
          ? (
              store.MH(scope) as {
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
        session.dispatchVoiceCommand(scope, { type: "STOP", reason: "failed" }, { prepend: true });
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
    session.dispatchVoiceCommand(scope, {
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
      MOr: routeScope.GD,
      CDr: composerScope.PR,
      B1n: {},
      SPn: store.MH,
      aT: flags.H3,
    },
    shared: {
      Qst: appScope.u,
      FBt: () => react,
      PNt: () => reactDom,
    },
    start: {
      t() {},
      n: startVoice,
    },
    prewarm: {
      VoiceInstantConnectCacheController: prewarmExports.VoiceInstantConnectCacheController,
      props: { loadVoiceSession: initializeVoiceSession },
    },
  };
}

function hashedRealtimeStart(
  ga: unknown,
): { runtime: object; start: (...args: unknown[]) => unknown } | undefined {
  const services = object(ga) ? ga.appServices : undefined;
  const runtime = object(services) ? services.realtimeVoiceRuntime : undefined;
  // 26.1106 GaA7.appServices.realtimeVoiceRuntime is a function carrying the
  // requestRealtimeStart property. A plain-object check misses it.
  if (typeof runtime !== "function" && !object(runtime)) return;
  const start = Reflect.get(runtime as object, "requestRealtimeStart");
  if (typeof start !== "function") return;
  return { runtime: runtime as object, start: start as (...args: unknown[]) => unknown };
}

/** Existing Chat threads have Send and no official Instant Connect slot.
 * Hashed START needs j9r7; GaA7 Instant Connect still starts Chat voice.
 */
export async function startHashedChatInstantConnect(
  importModule: (url: string) => Promise<RecordValue>,
): Promise<void> {
  const req = await resolveHashedWebpackRequire(importModule);
  if (!req) throw new Error("Hashed Chat Instant Connect is unavailable");
  let ga: unknown;
  try {
    ga = req("GaA7");
  } catch {
    throw new Error("Hashed Chat Instant Connect is unavailable");
  }
  const bound = hashedRealtimeStart(ga);
  if (!bound) throw new Error("Hashed Chat Instant Connect is unavailable");
  await Reflect.apply(bound.start, bound.runtime, [
    {
      productExperience: "chat",
      source: "composer_button_new_thread",
    },
  ]);
}
