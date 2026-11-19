import type { VoiceRoutes } from "@codexhost/shared-contracts";

export const SHARED_VOICE_CACHE = "codexhost.voice-routes-cache.v1";
export const CPA_LIVE_VOICE_STORAGE_KEY = "codexhost.cpa-live-voice.v1";
export const CHAT_LIVE_VOICE_STORAGE_KEY = "codexhost.chat-live-voice.v1";

type VoicePreferenceState = {
  sharedRoutes: WeakMap<object, VoiceRoutes>;
  gatewayReady: WeakMap<object, boolean>;
};

const voiceStateOwner = globalThis as typeof globalThis & {
  __codexhostVoicePreferenceStateV1?: VoicePreferenceState;
};

export function voicePreferenceState(): VoicePreferenceState {
  return (voiceStateOwner.__codexhostVoicePreferenceStateV1 ??= {
    sharedRoutes: new WeakMap<object, VoiceRoutes>(),
    gatewayReady: new WeakMap<object, boolean>(),
  });
}

export function parseVoiceRoutes(value: unknown): VoiceRoutes | undefined {
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    (record.chatExperience !== "chatgpt" && record.chatExperience !== "codex") ||
    (record.chatConnection !== "desktop" && record.chatConnection !== "gateway") ||
    (record.workConnection !== "desktop" && record.workConnection !== "gateway")
  )
    return;
  return {
    chatExperience: record.chatExperience,
    chatConnection: record.chatConnection,
    workConnection: record.workConnection,
  };
}

export function cachedVoiceRoutes(owner: object): VoiceRoutes | undefined {
  const { sharedRoutes } = voicePreferenceState();
  const memory = sharedRoutes.get(owner);
  if (memory) return memory;
  try {
    const storage = (owner as { localStorage?: Storage }).localStorage;
    const parsed = parseVoiceRoutes(JSON.parse(storage?.getItem(SHARED_VOICE_CACHE) ?? "null"));
    if (parsed) sharedRoutes.set(owner, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

export function rememberVoiceRoutes(owner: object, routes: VoiceRoutes): void {
  voicePreferenceState().sharedRoutes.set(owner, routes);
}

export function readVoiceStorageFlag(
  owner: object,
  key: string,
  enabledWhenUnset: boolean,
): boolean {
  const storage = (owner as { localStorage?: Storage }).localStorage;
  if (!storage) return enabledWhenUnset;
  try {
    const value = storage.getItem(key);
    return enabledWhenUnset ? value !== "0" : value === "1";
  } catch {
    return enabledWhenUnset;
  }
}

/** ChatGPT Instant Connect is available when Chat is not routed through Codex. */
export function nativeChatVoicePreferenceAllowsStart(owner: object): boolean {
  const routes = cachedVoiceRoutes(owner);
  return routes
    ? routes.chatExperience === "chatgpt"
    : !readVoiceStorageFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false);
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
