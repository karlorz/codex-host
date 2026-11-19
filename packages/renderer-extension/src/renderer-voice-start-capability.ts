import {
  gatewayVoiceStartRequest,
  overlayVoiceStarterFibers,
  wrapGatewayVoiceStarter,
} from "./renderer-voice-starter-core.js";
export {
  gatewayVoiceStartRequest,
  hashedOverlayVoiceStarterFibers,
  overlayVoiceStarterFibers,
  wrapGatewayVoiceStarter,
} from "./renderer-voice-starter-core.js";
import { selectVoiceAssets, supportsVoiceVersion } from "./renderer-voice-assets.js";
import { VOICE_GATEWAY_STATUS_METHOD } from "@codexhost/shared-contracts";
import {
  CLIENT_OWNED_VOICE_ASSETS,
  requestVoiceHost,
  type NativeVoiceBridge,
} from "./renderer-client-owned-voice.js";
import {
  bindVoiceCapabilitySubscriptions,
  initializeVoiceCapabilityFamilies,
} from "./renderer-voice-capability.js";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-hook.js";
import {
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
} from "./renderer-cpa-live-voice-preference.js";
import { workVoiceLaneEnabled, workVoiceUserFacingUnavailable } from "./renderer-voice-evidence.js";
import { isAvatarOverlayHref } from "./renderer-overlay-thread-isolation.js";

const GLOBAL = "__codexhostVoiceStartCapabilityV1";
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object";
type Start = (...args: unknown[]) => unknown;

interface Target {
  [key: string]: unknown;
  location?: { href: string };
  document?: Document;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** The overlay registers a native callback through an immutable RPC stub. Wrap
 * that service reference, preserving registration arguments and cancellation.
 */
export function installVoiceStartCapabilityHook(
  options: {
    target?: Target;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): { status: string; dispose(): void } {
  const target = options.target ?? (globalThis as unknown as Target);
  if (target[GLOBAL]) return target[GLOBAL] as { status: string; dispose(): void };
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config || !isAvatarOverlayHref(target.location?.href ?? ""))
    return { status: "disabled", dispose() {} };
  if (!supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, config.desktopVersion))
    return { status: "unsupported", dispose() {} };
  const importModule = options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  let restore: (() => void) | undefined;
  const wrappers = new Set<ReturnType<typeof wrapGatewayVoiceStarter>>();
  const started = Date.now();
  const handle = {
    status: "pending",
    dispose() {
      disposed = true;
      target.clearTimeout(timer);
      for (const wrapper of wrappers) wrapper.cancel();
      restore?.();
      if (target[GLOBAL] === handle) Reflect.deleteProperty(target, GLOBAL);
    },
  };
  target[GLOBAL] = handle;
  const attempt = async () => {
    if (disposed) return;
    try {
      const names = loadedAssetNames(target.document, target.performance);
      const assets = selectVoiceAssets(
        CLIENT_OWNED_VOICE_ASSETS,
        names,
        config.desktopVersion,
        config.desktopPlatform,
      );
      if (assets) {
        const shared = await importModule(`app://-/assets/${assets.shared}`);
        const init = "init" in assets ? assets.init : undefined;
        if (typeof init === "string" && typeof shared[init] === "function") {
          (shared[init] as () => void)();
        }
        const services = shared[assets.services];
        if (
          record(services) &&
          (record(services.realtimeVoiceRuntime) ||
            typeof services.realtimeVoiceRuntime === "function")
        ) {
          const original = services.realtimeVoiceRuntime;
          const register = Reflect.get(original, "registerRealtimeStarter");
          if (typeof register !== "function") throw new Error("Voice starter unavailable");
          const wrapped = new Proxy(original, {
            get(service, key, receiver) {
              if (key === "registerRealtimeStarter")
                return (start: Start, cancel: Start, ...rest: unknown[]) => {
                  if (typeof start !== "function" || typeof cancel !== "function")
                    throw new Error("Voice starter callback unavailable");
                  const wrapper = wrapGatewayVoiceStarter(start, {
                    configured: (request) => {
                      const mode = record(request) ? request.activeCollaborationMode : undefined;
                      const settings = record(mode) ? mode.settings : undefined;
                      const model = record(settings) ? settings.model : undefined;
                      return gatewayVoiceStartRequest(
                        request,
                        cpaLiveVoicePreferenceAllowsInstall(target),
                        chatLiveVoicePreferenceAllowsOverride(target),
                        typeof model === "string" && model.startsWith("codexhost/"),
                      );
                    },
                    qualifies: (request) =>
                      !disposed &&
                      !!readCpaLiveVoiceHookConfig(target) &&
                      gatewayVoiceStartRequest(
                        request,
                        cpaLiveVoicePreferenceAllowsInstall(target) &&
                          workVoiceLaneEnabled(target, "work-codex"),
                        chatLiveVoicePreferenceAllowsOverride(target),
                        workVoiceLaneEnabled(target, "work-grok"),
                      ),
                    unavailable: (request) => {
                      const mode = record(request) ? request.activeCollaborationMode : undefined;
                      const settings = record(mode) ? mode.settings : undefined;
                      const model = record(settings) ? settings.model : undefined;
                      const path =
                        typeof model === "string" && model.startsWith("codexhost/")
                          ? "work-grok"
                          : "work-codex";
                      return workVoiceUserFacingUnavailable(target, path);
                    },
                    ready: async () => {
                      const hook = target.__codexhostClientOwnedVoiceV1;
                      if (!record(hook) || hook.status !== "active") return false;
                      const bridgeClass = shared[assets.bridge] as {
                        getInstance(): NativeVoiceBridge;
                      };
                      const result = await requestVoiceHost(
                        bridgeClass.getInstance(),
                        {},
                        VOICE_GATEWAY_STATUS_METHOD,
                      );
                      return result === true;
                    },
                    prepare: async (allowed) => {
                      const names = loadedAssetNames(target.document, target.performance);
                      if (
                        selectVoiceAssets(
                          CLIENT_OWNED_VOICE_ASSETS,
                          names,
                          config.desktopVersion,
                          config.desktopPlatform,
                        ) !== assets
                      )
                        throw new Error("Unaudited voice starter");
                      const [initial, overlay] = await Promise.all([
                        importModule(`app://-/assets/${assets.initial}`),
                        importModule(`app://-/assets/${assets.overlay}`),
                      ]);
                      if (typeof overlay.AvatarOverlayNativePage !== "function" || !target.document)
                        throw new Error("Voice starter owner unavailable");
                      const document = target.document;
                      const { family, gates } = initializeVoiceCapabilityFamilies(initial, assets);
                      return bindVoiceCapabilitySubscriptions(
                        () => overlayVoiceStarterFibers(document, overlay.AvatarOverlayNativePage),
                        family,
                        gates,
                        allowed,
                        true,
                      );
                    },
                    // Wait for React's committed snapshot, including when the
                    // persistent overlay is hidden. A stale closure fails closed.
                    committed: async (binding) => {
                      for (let i = 0; i < 40 && !disposed && !binding.current(); i += 1)
                        await new Promise((resolve) => target.setTimeout(resolve, 50));
                    },
                  });
                  wrappers.add(wrapper);
                  return Reflect.apply(register, original, [
                    wrapper.start,
                    (...args: unknown[]) => {
                      wrapper.cancel();
                      return cancel(...args);
                    },
                    ...rest,
                  ]);
                };
              if (key === "unregisterRealtimeStarter")
                return (...args: unknown[]) => {
                  for (const wrapper of wrappers) wrapper.cancel();
                  wrappers.clear();
                  return Reflect.apply(Reflect.get(service, key), service, args);
                };
              return Reflect.get(service, key, receiver);
            },
          });
          if (disposed) return;
          if (!Reflect.set(services, "realtimeVoiceRuntime", wrapped))
            throw new Error("Voice service is not writable");
          restore = () => {
            if (services.realtimeVoiceRuntime === wrapped) services.realtimeVoiceRuntime = original;
          };
          handle.status = "active";
          return;
        }
      }
      if (Date.now() - started >= 60_000) {
        handle.status = "unsupported";
        return;
      }
      timer = target.setTimeout(() => void attempt(), 25);
    } catch {
      handle.status = "unsupported";
    }
  };
  void attempt();
  return handle;
}
