import { voiceRoutesSchema, type VoiceRoutes } from "@codexhost/shared-contracts";
import {
  CHAT_LIVE_VOICE_STORAGE_KEY,
  CPA_LIVE_VOICE_STORAGE_KEY,
  SHARED_VOICE_CACHE,
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

export {
  readCpaLiveVoicePreference,
  readChatLiveVoicePreference,
  cpaLiveVoicePreferenceAllowsInstall,
  chatLiveVoicePreferenceAllowsOverride,
} from "./renderer-voice-routes-cache.js";
