import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import type { ChatVoiceScope } from "./renderer-native-chat-voice.js";

const CONNECTION_STATES = [
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "signalReconnecting",
] as const;
const REMOTE_STATES = ["connecting", "speaking", "thinking", "listening", "idle"] as const;
const QUALITY_STATES = ["lost", "poor", "good", "excellent"] as const;

function allowlisted(
  value: unknown,
  allowed: readonly string[],
): (typeof allowed)[number] | "unknown" {
  return typeof value === "string" && allowed.includes(value) ? value : "unknown";
}

function serverConversationReady(value: unknown): boolean {
  return typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
}

/**
 * Observe audited Instant Connect lifecycle flags only.
 * `hasSpoken` / `metrics.numSpeaking` are remote `new_state==='speaking'` updates.
 * `isUserSpeaking` / `isAssistantSpeaking` are actor-state. `relayReady` is a
 * processed remote message. `voiceConnectionQuality` is connection quality.
 * Device output counters live on a separate AudioContext helper, not this store.
 */
export function observeNativeChatVoiceState(
  scope: ChatVoiceScope,
  initial: Record<string, unknown>,
): () => void {
  const store = Reflect.apply(initial.SPn as (...args: unknown[]) => unknown, undefined, [
    scope,
  ]) as {
    getState(): {
      isVoiceModeActive?: boolean;
      hasConnectedOnce?: boolean;
      hasVoiceSessionStarted?: boolean;
      hasSpoken?: boolean;
      isUserSpeaking?: boolean;
      isAssistantSpeaking?: boolean;
      isInstantAudioCapturing?: boolean;
      isDuckingActive?: boolean;
      earlyServerThreadId?: unknown;
      metrics?: { numSpeaking?: unknown };
      server?: {
        connectionState?: unknown;
        remoteState?: unknown;
        relayReady?: unknown;
        voiceConnectionQuality?: unknown;
      };
    };
    subscribe(listener: () => void): () => void;
  };
  let last = "";
  let lastCapture = "";
  let lastOutput = "";
  let lastResponse = "";
  const report = () => {
    const state = store.getState();
    const server = state.server;
    const captureActive = state.isInstantAudioCapturing === true;
    const userActorSpeaking = state.isUserSpeaking === true;
    const assistantActorSpeaking = state.isAssistantSpeaking === true;
    const remote = allowlisted(server?.remoteState, REMOTE_STATES);
    const remoteMessageProcessed = server?.relayReady === true;
    const hasRemoteSpoken = state.hasSpoken === true;
    const remoteSpeakingUpdates =
      typeof state.metrics?.numSpeaking === "number" && state.metrics.numSpeaking > 0;
    const connectionQuality = allowlisted(server?.voiceConnectionQuality, QUALITY_STATES);
    const detail = {
      active: state.isVoiceModeActive === true,
      connectedOnce: state.hasConnectedOnce === true,
      sessionStarted: state.hasVoiceSessionStarted === true,
      serverConversationReady: serverConversationReady(state.earlyServerThreadId),
      connection: allowlisted(server?.connectionState, CONNECTION_STATES),
      captureActive,
      userActorSpeaking,
      assistantActorSpeaking,
      ducking: state.isDuckingActive === true,
      remote,
      remoteMessageProcessed,
      hasRemoteSpoken,
      remoteSpeakingUpdates,
      connectionQuality,
      deviceOutput: "unknown",
      userInputEvidence: "unknown",
    };
    const next = JSON.stringify(detail);
    if (next !== last) {
      last = next;
      chatVoiceDebug("native-chat-state", detail);
    }
    const capture = JSON.stringify({ captureActive, userActorSpeaking });
    if (capture !== lastCapture) {
      lastCapture = capture;
      chatVoiceDebug("native-chat-capture", {
        captureActive,
        userActorSpeaking,
        userInputEvidence: "unknown",
      });
    }
    const output = JSON.stringify({
      assistantActorSpeaking,
      ducking: detail.ducking,
    });
    if (output !== lastOutput) {
      lastOutput = output;
      chatVoiceDebug("native-chat-output", {
        assistantActorSpeaking,
        ducking: detail.ducking,
        deviceOutput: "unknown",
      });
    }
    const response = JSON.stringify({
      remote,
      remoteMessageProcessed,
      hasRemoteSpoken,
      remoteSpeakingUpdates,
    });
    if (response !== lastResponse) {
      lastResponse = response;
      chatVoiceDebug("native-chat-response", {
        remote,
        remoteMessageProcessed,
        hasRemoteSpoken,
        remoteSpeakingUpdates,
      });
    }
  };
  const unsubscribe = store.subscribe(report);
  report();
  return unsubscribe;
}
