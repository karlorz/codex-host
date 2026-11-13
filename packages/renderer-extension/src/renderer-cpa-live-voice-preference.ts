import { voiceRoutesSchema, type VoiceRoutes } from "@codexhost/shared-contracts";
import {
  CHAT_LIVE_VOICE_STORAGE_KEY,
  CPA_LIVE_VOICE_STORAGE_KEY,
  SHARED_VOICE_CACHE,
  cachedVoiceRoutes,
  nativeChatVoicePreferenceAllowsStart,
  readVoiceStorageFlag,
  rememberVoiceRoutes,
  voicePreferenceState,
} from "./renderer-voice-routes-cache.js";

export {
  CHAT_LIVE_VOICE_STORAGE_KEY,
  CPA_LIVE_VOICE_STORAGE_KEY,
  nativeChatVoicePreferenceAllowsStart,
};

export function applyVoiceGatewayReadiness(owner: object, ready: boolean): void {
  voicePreferenceState().gatewayReady.set(owner, ready);
}
export function voiceGatewayIsReady(owner: object): boolean {
  return voicePreferenceState().gatewayReady.get(owner) === true;
}

export function applySharedVoiceRoutes(owner: object, routes: VoiceRoutes): void {
  const snapshot = voiceRoutesSchema.parse({
    chatExperience: routes.chatExperience,
    chatConnection: routes.chatConnection,
    workConnection: routes.workConnection,
  });
  rememberVoiceRoutes(owner, snapshot);
  try {
    (owner as { localStorage?: Storage }).localStorage?.setItem(
      SHARED_VOICE_CACHE,
      JSON.stringify(snapshot),
    );
  } catch {
    /* Memory retains the applied route if browser storage is unavailable. */
  }
}

export function legacyVoiceRoutes(owner: Window): VoiceRoutes {
  const chatLegacy = readVoiceStorageFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false);
  return {
    chatExperience: chatLegacy ? "codex" : "chatgpt",
    chatConnection: chatLegacy ? "gateway" : "desktop",
    workConnection: readVoiceStorageFlag(owner, CPA_LIVE_VOICE_STORAGE_KEY, true)
      ? "gateway"
      : "desktop",
  };
}

/** Codex Work gateway choice; legacy storage is read only until shared migration. */
export function readCpaLiveVoicePreference(owner: Window): boolean {
  const routes = cachedVoiceRoutes(owner);
  return routes
    ? routes.workConnection === "gateway"
    : readVoiceStorageFlag(owner, CPA_LIVE_VOICE_STORAGE_KEY, true);
}

/** Gateway is an explicit Codex Chat connection, independent of native ChatGPT. */
export function readChatLiveVoicePreference(owner: Window): boolean {
  const routes = cachedVoiceRoutes(owner);
  return routes
    ? routes.chatExperience === "codex" && routes.chatConnection === "gateway"
    : readVoiceStorageFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false);
}

/** Work override state for the injected hook, which only exposes a global object. */
export function cpaLiveVoicePreferenceAllowsInstall(globalObject: object): boolean {
  return readCpaLiveVoicePreference(globalObject as Window);
}

/** Chat override state for the injected hook, which only exposes a global object. */
export function chatLiveVoicePreferenceAllowsOverride(globalObject: object): boolean {
  return readChatLiveVoicePreference(globalObject as Window);
}
