import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-config.js";
import {
  rememberVoiceProductExperience,
  wrapClientOwnedVoiceFetch,
  type NativeVoiceBridge,
  type NativeVoiceFetch,
} from "./renderer-voice-gateway-wrap.js";
import { isWorkComposerSurface } from "./renderer-work-composer-surface.js";
import {
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
} from "./renderer-hashed-webpack-voice.js";

export { HASHED_WEBPACK_VOICE_RUNTIME_ASSET, HASHED_WEBPACK_VOICE_VERSION };

const HOOK_GLOBAL = "__codexhostClientOwnedVoiceV1";
const SHARED_VOICE_CACHE = "codexhost.voice-routes-cache.v1";
const WORK_GATEWAY_FLAG = "codexhost.cpa-live-voice.v1";
const CHAT_GATEWAY_FLAG = "codexhost.chat-live-voice.v1";

type RecordValue = Record<string, unknown>;

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

export interface ClientOwnedVoiceActivation {
  assetSeen: boolean;
  importStarted: boolean;
  importResolved: boolean;
  importFailed?: string;
  factoryHooked?: boolean;
  wrapperActive: boolean;
}

interface VoiceTarget {
  [key: string]: unknown;
  document?: ParentNode;
  location?: { href?: string };
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

function overlayCompactVoiceDocument(target: VoiceTarget): boolean {
  try {
    const href =
      target.location?.href ??
      (globalThis as { location?: { href?: string } }).location?.href ??
      "";
    return href.includes("avatar-overlay");
  } catch {
    return false;
  }
}

/** Named-asset overlays remember productExperience from wrapGatewayVoiceStarter.
 * 26.1106 hashed overlay start has no productExperience, so the primary
 * Composer surface is persisted for the overlay wrap to read.
 */
function visibleComposerLaunchExperience(target: VoiceTarget): "chat" | "work" | undefined {
  const document = target.document as Document | undefined;
  if (!document?.querySelectorAll) return;
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect?.() ?? { width: 0 };
    return box.width > 0 && !element.closest?.("[hidden], [inert]");
  };
  const chat = [...document.querySelectorAll("[data-chatgpt-composer]")].some(visible);
  const work = [...document.querySelectorAll("[data-codex-composer-root]")].some(visible);
  if (chat && !work) return "chat";
  if (work && !chat) return "work";
}

function publishComposerLaunchExperience(target: VoiceTarget): void {
  if (overlayCompactVoiceDocument(target)) return;
  rememberVoiceProductExperience(
    {
      productExperience:
        visibleComposerLaunchExperience(target) ??
        (isWorkComposerSurface(target) ? "work" : "chat"),
    },
    target,
  );
}

interface VoiceHook {
  status: "disabled" | "pending" | "active" | "unsupported";
  activation?: ClientOwnedVoiceActivation;
  dispose(): void;
}

function hashedWebpackVoiceSupported(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): boolean {
  return (
    config.desktopVersion === HASHED_WEBPACK_VOICE_VERSION &&
    (config.desktopPlatform === undefined || config.desktopPlatform === "darwin")
  );
}

function cachedConnection(owner: object, field: "workConnection" | "chatConnection"): unknown {
  try {
    const parsed = JSON.parse(
      (owner as { localStorage?: Storage }).localStorage?.getItem(SHARED_VOICE_CACHE) ?? "null",
    ) as RecordValue | null;
    return object(parsed) ? parsed[field] : undefined;
  } catch {
    return undefined;
  }
}

function cachedChatExperience(owner: object): unknown {
  try {
    const parsed = JSON.parse(
      (owner as { localStorage?: Storage }).localStorage?.getItem(SHARED_VOICE_CACHE) ?? "null",
    ) as RecordValue | null;
    return object(parsed) ? parsed.chatExperience : undefined;
  } catch {
    return undefined;
  }
}

function storageFlag(owner: object, key: string, enabledWhenUnset: boolean): boolean {
  const storage = (owner as { localStorage?: Storage }).localStorage;
  if (!storage) return enabledWhenUnset;
  try {
    const value = storage.getItem(key);
    return enabledWhenUnset ? value !== "0" : value === "1";
  } catch {
    return enabledWhenUnset;
  }
}

function workGatewayEnabled(owner: object): boolean {
  const connection = cachedConnection(owner, "workConnection");
  return connection !== undefined
    ? connection === "gateway"
    : storageFlag(owner, WORK_GATEWAY_FLAG, true);
}

function chatGatewayEnabled(owner: object): boolean {
  const experience = cachedChatExperience(owner);
  const connection = cachedConnection(owner, "chatConnection");
  if (experience !== undefined || connection !== undefined)
    return experience === "codex" && connection === "gateway";
  return storageFlag(owner, CHAT_GATEWAY_FLAG, false);
}

function nativeVoiceOwner(value: unknown): object | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as object)
    : undefined;
}

function nativeVoiceInstance(value: unknown): unknown {
  const owner = nativeVoiceOwner(value);
  if (!owner) return value;
  const getInstance = Reflect.get(owner, "getInstance");
  return typeof getInstance === "function" ? getInstance.call(owner) : owner;
}

function nativeVoiceFetch(value: unknown): NativeVoiceFetch | undefined {
  const instance = nativeVoiceInstance(value);
  if (!object(instance) || typeof instance.fetch !== "function") return undefined;
  return instance as unknown as NativeVoiceFetch;
}

function nativeVoiceBridge(value: unknown): NativeVoiceBridge | undefined {
  const instance = nativeVoiceInstance(value);
  if (
    !object(instance) ||
    typeof instance.dispatchMessage !== "function" ||
    typeof instance.subscribe !== "function"
  ) {
    return undefined;
  }
  return instance as unknown as NativeVoiceBridge;
}

interface WebpackModule {
  exports?: unknown;
}

interface WebpackFactory {
  (this: unknown, module?: WebpackModule, exports?: unknown, require?: unknown): unknown;
  __codexhostVoiceFactory?: boolean;
}

interface WebpackRequire {
  (id: string): unknown;
  m?: Record<string, WebpackFactory | undefined>;
  c?: Record<string, WebpackModule | undefined>;
}

function isWebpackRequire(value: unknown): value is WebpackRequire {
  return typeof value === "function";
}

function peekWebpackExport(req: WebpackRequire, id: string): unknown {
  return req.c?.[id]?.exports;
}

function unpoisonIncompleteWebpackModule(
  req: WebpackRequire,
  id: string,
  usable: (value: unknown) => boolean,
): void {
  const cache = req.c;
  const cached = cache?.[id];
  if (!cache || !cached || usable(cached.exports)) return;
  try {
    delete cache[id];
  } catch {
    /* Native Voice Chat cannot start from an empty GDNt cache entry. */
  }
}

function safeWebpackRequire(req: WebpackRequire, id: string): unknown {
  const existing = peekWebpackExport(req, id);
  if (object(existing) && Object.keys(existing).length > 0) return existing;
  try {
    return req(id);
  } catch {
    unpoisonIncompleteWebpackModule(
      req,
      id,
      (value) => object(value) && Object.keys(value).length > 0,
    );
    return undefined;
  }
}

function readGdntExports(req: WebpackRequire): unknown {
  const peeked = peekWebpackExport(req, "GDNt");
  if (nativeVoiceFetch(object(peeked) ? peeked._n : undefined)) return peeked;
  unpoisonIncompleteWebpackModule(req, "GDNt", (value) =>
    Boolean(nativeVoiceFetch(object(value) ? value._n : undefined)),
  );
  if (typeof req.m?.GDNt === "function") return undefined;
  return safeWebpackRequire(req, "GDNt");
}

function hookWebpackVoiceFactory(
  req: WebpackRequire,
  onExports: (exports: unknown) => void,
): boolean {
  const modules = req.m;
  const original = modules?.GDNt;
  if (!modules || typeof original !== "function") return false;
  if (original.__codexhostVoiceFactory) return true;
  const wrapped: WebpackFactory = function (this: unknown, module, exports, webpackRequire) {
    try {
      return original.apply(this, [module, exports, webpackRequire]);
    } finally {
      onExports(exports ?? module?.exports);
    }
  };
  wrapped.__codexhostVoiceFactory = true;
  modules.GDNt = wrapped;
  return true;
}

async function resolveHashedWebpackVoice(
  importModule: (url: string) => Promise<RecordValue>,
): Promise<{
  client?: NativeVoiceFetch;
  bridge: NativeVoiceBridge;
  responseError: (response: Response, url: string) => Promise<unknown>;
  require?: WebpackRequire;
} | null> {
  const runtime = await importModule(`app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}`);
  const req = runtime?.__webpack_require__;
  if (!isWebpackRequire(req)) return null;
  const gdnt = readGdntExports(req);
  const client = nativeVoiceFetch(object(gdnt) ? gdnt._n : undefined);
  const hostBridge = safeWebpackRequire(req, "TL6G");
  const bridged = nativeVoiceBridge(object(hostBridge) ? hostBridge.O1 : undefined);
  const errorModule = safeWebpackRequire(req, "eShZ");
  const responseError = object(errorModule) ? errorModule.s1 : undefined;
  if (!bridged || typeof responseError !== "function") return null;
  if (client)
    return {
      client,
      bridge: bridged,
      responseError: responseError as (response: Response, url: string) => Promise<unknown>,
    };
  if (typeof req.m?.GDNt !== "function") return null;
  return {
    bridge: bridged,
    responseError: responseError as (response: Response, url: string) => Promise<unknown>,
    require: req,
  };
}

/** Overlay-only hashed webpack wrap. Does not import named voice assets, preference
 * schemas, or the full overlay hook. Wait until Desktop has loaded 348410 before
 * importing it, then wrap GDNt._n.getInstance().fetch without blocking native start.
 */
export function installHashedOverlayVoiceHook(
  options: {
    target?: VoiceTarget;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): VoiceHook {
  const target = options.target ?? (globalThis as unknown as VoiceTarget);
  const existing = target[HOOK_GLOBAL] as VoiceHook | undefined;
  if (existing) return existing;
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config) return { status: "disabled", dispose() {} };
  if (!hashedWebpackVoiceSupported(config)) return { status: "unsupported", dispose() {} };
  const importModule = options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let surfaceTimer: ReturnType<typeof setTimeout> | undefined;
  let restore: (() => void) | undefined;
  const started = Date.now();
  const activation: ClientOwnedVoiceActivation = {
    assetSeen: false,
    importStarted: false,
    importResolved: false,
    factoryHooked: false,
    wrapperActive: false,
  };
  const pointerTarget = target.document as
    (ParentNode & { addEventListener?: typeof document.addEventListener }) | undefined;
  const onPointerDown = () => publishComposerLaunchExperience(target);
  const handle: VoiceHook = {
    status: "pending",
    activation,
    dispose() {
      disposed = true;
      if (timer !== undefined) target.clearTimeout(timer);
      if (surfaceTimer !== undefined) target.clearTimeout(surfaceTimer);
      pointerTarget?.removeEventListener?.("pointerdown", onPointerDown, true);
      restore?.();
      if (target[HOOK_GLOBAL] === handle) Reflect.deleteProperty(target, HOOK_GLOBAL);
    },
  };
  target[HOOK_GLOBAL] = handle;
  pointerTarget?.addEventListener?.("pointerdown", onPointerDown, true);
  const publishLoop = (): void => {
    if (disposed) return;
    publishComposerLaunchExperience(target);
    surfaceTimer = target.setTimeout(publishLoop, 250);
  };
  publishLoop();
  const activate = (
    client: NativeVoiceFetch,
    bridge: NativeVoiceBridge,
    responseError: (response: Response, url: string) => Promise<unknown>,
  ): void => {
    restore = wrapClientOwnedVoiceFetch(
      client,
      bridge,
      () => workGatewayEnabled(target),
      responseError,
      () => chatGatewayEnabled(target),
      () => !overlayCompactVoiceDocument(target) && isWorkComposerSurface(target),
      () => false,
      () => overlayCompactVoiceDocument(target),
    );
    activation.wrapperActive = true;
    handle.status = "active";
  };
  const attempt = async (): Promise<void> => {
    if (disposed || handle.status === "active") return;
    publishComposerLaunchExperience(target);
    const names = loadedAssetNames(target.document, target.performance);
    const hashedAssetSeen = names.some((name) => name.includes(HASHED_WEBPACK_VOICE_RUNTIME_ASSET));
    if (hashedAssetSeen) activation.assetSeen = true;
    if (hashedAssetSeen) {
      activation.importStarted = true;
      try {
        const resolved = await resolveHashedWebpackVoice(importModule);
        if (disposed || activation.wrapperActive) return;
        if (resolved?.client) {
          activation.importResolved = true;
          delete activation.importFailed;
          activate(resolved.client, resolved.bridge, resolved.responseError);
          return;
        }
        const webpackRequire = resolved?.require;
        if (
          webpackRequire &&
          hookWebpackVoiceFactory(webpackRequire, (exports) => {
            if (disposed || activation.wrapperActive) return;
            const client = nativeVoiceFetch(object(exports) ? exports._n : undefined);
            if (!client) {
              unpoisonIncompleteWebpackModule(webpackRequire, "GDNt", (value) =>
                Boolean(nativeVoiceFetch(object(value) ? value._n : undefined)),
              );
              return;
            }
            activate(client, resolved.bridge, resolved.responseError);
          })
        ) {
          activation.importResolved = true;
          activation.factoryHooked = true;
          delete activation.importFailed;
          return;
        }
        activation.importFailed = "hashed webpack voice exports were missing";
      } catch (error) {
        activation.importFailed = error instanceof Error ? error.message : "hashed import failed";
      }
    }
    timer = target.setTimeout(() => void attempt(), Date.now() - started >= 5_000 ? 1_000 : 250);
  };
  void attempt();
  return handle;
}
