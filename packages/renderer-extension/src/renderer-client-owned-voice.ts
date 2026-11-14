import {
  CLIENT_OWNED_VOICE_ASSETS,
  hashedVoiceProfileSupported,
} from "./renderer-voice-profiles.js";
export {
  CLIENT_OWNED_VOICE_VERSION,
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
  CLIENT_OWNED_VOICE_OVERLAY_ASSET,
  CLIENT_OWNED_VOICE_ASSETS,
} from "./renderer-voice-profiles.js";
import { selectVoiceAssets, supportsVoiceVersion } from "./renderer-voice-assets.js";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-config.js";
import { workVoiceLaneEnabled } from "./renderer-voice-evidence.js";
import {
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
} from "./renderer-cpa-live-voice-preference.js";
import {
  lastVoiceLaunchProductExperience,
  rememberVoiceProductExperience,
  requestVoiceHost,
  VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY,
  wrapClientOwnedVoiceFetch,
  type NativeVoiceBridge,
  type NativeVoiceFetch,
} from "./renderer-voice-gateway-wrap.js";
import {
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
  installHashedOverlayVoiceHook,
  type ClientOwnedVoiceActivation,
} from "./renderer-hashed-overlay-voice.js";
import {
  HOME_COMPOSER_MODE_STORAGE_KEY,
  isWorkComposerSurface,
} from "./renderer-work-composer-surface.js";

export { HOME_COMPOSER_MODE_STORAGE_KEY, isWorkComposerSurface };

export {
  lastVoiceLaunchProductExperience,
  rememberVoiceProductExperience,
  requestVoiceHost,
  VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY,
  wrapClientOwnedVoiceFetch,
  type NativeVoiceBridge,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
  type ClientOwnedVoiceActivation,
};

const SHARED_INIT = "Oit";
const SHARED_RESPONSE_ERROR = "Mit";
const HOOK_GLOBAL = "__codexhostClientOwnedVoiceV1";

function selectedComposerModel(owner: object): string {
  const routing = (
    owner as {
      __codexhostHostRoutingV1?: {
        forComposer(): { policy: { selectedModel(): string | null } } | undefined;
      };
    }
  ).__codexhostHostRoutingV1;
  try {
    const model = routing?.forComposer()?.policy.selectedModel();
    return typeof model === "string" ? model : "";
  } catch {
    return "";
  }
}

export function isExternalHarnessComposer(owner: object = globalThis): boolean {
  const experience = lastVoiceLaunchProductExperience();
  if (experience === "chat") return false;
  return selectedComposerModel(owner).startsWith("codexhost/");
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

interface VoiceTarget {
  [key: string]: unknown;
  document?: ParentNode;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

interface VoiceHook {
  status: "disabled" | "pending" | "active" | "unsupported";
  activation?: ClientOwnedVoiceActivation;
  dispose(): void;
}

/** Desktop 26.1016+ always creates calls in the Renderer. Its native WebFetch
 * singleton and message bridge are audited exports of the versioned native modules.
 */
export function installClientOwnedVoiceHook(
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
  if (hashedVoiceProfileSupported(config)) {
    return installHashedOverlayVoiceHook({
      target,
      ...(options.importModule ? { importModule: options.importModule } : {}),
    });
  }
  if (!supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, config.desktopVersion))
    return { status: "unsupported", dispose() {} };
  const importModule = options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restore: (() => void) | undefined;
  const started = Date.now();
  const activation: ClientOwnedVoiceActivation = {
    assetSeen: false,
    importStarted: false,
    importResolved: false,
    wrapperActive: false,
  };
  const handle: VoiceHook = {
    status: "pending",
    activation,
    dispose() {
      disposed = true;
      if (timer !== undefined) target.clearTimeout(timer);
      restore?.();
      if (target[HOOK_GLOBAL] === handle) Reflect.deleteProperty(target, HOOK_GLOBAL);
    },
  };
  target[HOOK_GLOBAL] = handle;
  const activate = (
    client: NativeVoiceFetch,
    bridge: NativeVoiceBridge,
    responseError: (response: Response, url: string) => Promise<unknown>,
  ): void => {
    restore = wrapClientOwnedVoiceFetch(
      client,
      bridge,
      () =>
        cpaLiveVoicePreferenceAllowsInstall(target) && workVoiceLaneEnabled(target, "work-codex"),
      responseError,
      () => chatLiveVoicePreferenceAllowsOverride(target),
      () => isWorkComposerSurface(target),
      () => isExternalHarnessComposer(target),
      () => false,
      () => workVoiceLaneEnabled(target, "work-grok"),
    );
    activation.wrapperActive = true;
    handle.status = "active";
  };
  const attempt = async (): Promise<void> => {
    if (disposed) return;
    const names = loadedAssetNames(target.document, target.performance);
    const assets = selectVoiceAssets(
      CLIENT_OWNED_VOICE_ASSETS,
      names,
      config.desktopVersion,
      config.desktopPlatform,
    );
    if (handle.status !== "active" && assets) {
      try {
        const sharedModule = await importModule(`app://-/assets/${assets.shared}`);
        const fetchFrom = "fetchFrom" in assets ? assets.fetchFrom : "shared";
        const fetchModule =
          fetchFrom === "initial"
            ? await importModule(`app://-/assets/${assets.initial}`)
            : sharedModule;
        if (disposed) return;
        const init = "init" in assets ? assets.init : SHARED_INIT;
        const fetchName = assets.fetch;
        const bridgeName = assets.bridge;
        const errorName = "responseError" in assets ? assets.responseError : SHARED_RESPONSE_ERROR;
        if (typeof init === "string" && typeof fetchModule[init] === "function") {
          (fetchModule[init] as () => void)();
        } else if (typeof init === "string" && typeof sharedModule[init] === "function") {
          (sharedModule[init] as () => void)();
        }
        const fetchClass = typeof fetchName === "string" ? fetchModule[fetchName] : undefined;
        const bridgeClass = typeof bridgeName === "string" ? sharedModule[bridgeName] : undefined;
        if (!object(fetchClass) && typeof fetchClass !== "function") throw new Error();
        if (!object(bridgeClass) && typeof bridgeClass !== "function") throw new Error();
        const client = Reflect.get(fetchClass, "getInstance").call(fetchClass);
        const bridge = Reflect.get(bridgeClass, "getInstance").call(bridgeClass);
        const errorModule =
          "responseErrorFrom" in assets && assets.responseErrorFrom === "initial"
            ? fetchModule
            : sharedModule;
        const responseError =
          typeof errorName === "string" && typeof errorModule[errorName] === "function"
            ? (errorModule[errorName] as (response: Response, url: string) => Promise<unknown>)
            : async (response: Response) => {
                throw Object.assign(new Error(await response.text()), { status: response.status });
              };
        if (
          typeof client?.fetch !== "function" ||
          typeof bridge?.dispatchMessage !== "function" ||
          typeof bridge?.subscribe !== "function"
        )
          throw new Error();
        activate(client, bridge, responseError);
      } catch {
        /* Retry below until the timeout. */
      }
    }
    if (handle.status === "active") return;
    if (Date.now() - started >= 60_000) {
      handle.status = "unsupported";
      return;
    }
    timer = target.setTimeout(() => void attempt(), 250);
  };
  void attempt();
  return handle;
}
