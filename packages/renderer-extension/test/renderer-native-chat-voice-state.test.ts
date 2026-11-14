import { describe, expect, it, vi } from "vitest";
import { chatVoiceDebug } from "../src/renderer-chat-voice-debug.js";
import { observeNativeChatVoiceState } from "../src/renderer-native-chat-voice-state.js";
import type { ChatVoiceScope } from "../src/renderer-native-chat-voice.js";

vi.mock("../src/renderer-chat-voice-debug.js", () => ({ chatVoiceDebug: vi.fn() }));

describe("native Chat lifecycle diagnostics", () => {
  it("records connection transitions without native payloads and unsubscribes", () => {
    vi.mocked(chatVoiceDebug).mockClear();
    const state = {
      isVoiceModeActive: false,
      hasConnectedOnce: false,
      hasVoiceSessionStarted: false,
      earlyServerThreadId: null as unknown,
      server: { connectionState: "connecting", messages: ["private transcript"] },
      voiceSessionId: "private session ID",
      pendingDisconnect: { error: "private error" },
    };
    const get = vi.fn();
    const scope = { get } as unknown as ChatVoiceScope;
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn(() => {
      listener = undefined;
    });
    const stop = observeNativeChatVoiceState(scope, {
      SPn: () => ({
        getState: () => state,
        subscribe: (next: () => void) => {
          listener = next;
          return unsubscribe;
        },
      }),
    });
    listener?.();
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-state",
      expect.objectContaining({
        active: false,
        connection: "connecting",
        captureActive: false,
        deviceOutput: "unknown",
        userInputEvidence: "unknown",
      }),
    );
    Object.assign(state, { isVoiceModeActive: true, hasConnectedOnce: true });
    state.server.connectionState = "connected";
    listener?.();
    expect(chatVoiceDebug).toHaveBeenLastCalledWith(
      "native-chat-state",
      expect.objectContaining({
        active: true,
        connectedOnce: true,
        sessionStarted: false,
        serverConversationReady: false,
        connection: "connected",
        captureActive: false,
        userActorSpeaking: false,
        assistantActorSpeaking: false,
        remote: "unknown",
        remoteMessageProcessed: false,
        deviceOutput: "unknown",
      }),
    );
    state.earlyServerThreadId = "a7e3282d-f457-4586-9b28-921411364f6b";
    listener?.();
    expect(chatVoiceDebug).toHaveBeenLastCalledWith(
      "native-chat-state",
      expect.objectContaining({ serverConversationReady: true }),
    );
    expect(JSON.stringify(vi.mocked(chatVoiceDebug).mock.calls)).not.toContain(
      state.earlyServerThreadId,
    );
    state.server.connectionState = "private transport error";
    listener?.();
    expect(chatVoiceDebug).toHaveBeenLastCalledWith(
      "native-chat-state",
      expect.objectContaining({
        connection: "unknown",
      }),
    );
    expect(JSON.stringify(vi.mocked(chatVoiceDebug).mock.calls)).not.toContain("private");
    expect(get).not.toHaveBeenCalled();
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listener).toBeUndefined();
  });

  it("records sanitized capture, remote-response, and output actor-state without claiming speech or playback", () => {
    vi.mocked(chatVoiceDebug).mockClear();
    const state = {
      isVoiceModeActive: true,
      hasConnectedOnce: true,
      hasVoiceSessionStarted: true,
      hasSpoken: false,
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      isInstantAudioCapturing: false,
      isDuckingActive: false,
      earlyServerThreadId: "a7e3282d-f457-4586-9b28-921411364f6b",
      metrics: { numSpeaking: 0, userSpeakingTimeMs: 12 },
      server: {
        connectionState: "connected",
        remoteState: "thinking",
        relayReady: false,
        voiceConnectionQuality: "good",
        messages: ["private transcript"],
      },
    };
    let listener: (() => void) | undefined;
    observeNativeChatVoiceState({ get() {} } as unknown as ChatVoiceScope, {
      SPn: () => ({
        getState: () => state,
        subscribe: (next: () => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      }),
    });
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-capture",
      expect.objectContaining({
        captureActive: false,
        userActorSpeaking: false,
        userInputEvidence: "unknown",
      }),
    );
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-response",
      expect.objectContaining({
        remote: "thinking",
        remoteMessageProcessed: false,
        hasRemoteSpoken: false,
        remoteSpeakingUpdates: false,
      }),
    );
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-output",
      expect.objectContaining({
        assistantActorSpeaking: false,
        deviceOutput: "unknown",
      }),
    );
    Object.assign(state, {
      isInstantAudioCapturing: true,
      isUserSpeaking: true,
      hasSpoken: true,
      isAssistantSpeaking: true,
      metrics: { numSpeaking: 2, userSpeakingTimeMs: 12 },
    });
    state.server.remoteState = "speaking";
    state.server.relayReady = true;
    listener?.();
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-capture",
      expect.objectContaining({
        captureActive: true,
        userActorSpeaking: true,
        userInputEvidence: "unknown",
      }),
    );
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-response",
      expect.objectContaining({
        remote: "speaking",
        remoteMessageProcessed: true,
        hasRemoteSpoken: true,
        remoteSpeakingUpdates: true,
      }),
    );
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-output",
      expect.objectContaining({
        assistantActorSpeaking: true,
        deviceOutput: "unknown",
      }),
    );
    const serialized = JSON.stringify(vi.mocked(chatVoiceDebug).mock.calls);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain(state.earlyServerThreadId);
    expect(serialized).not.toContain('"spoken"');
    expect(serialized).not.toContain("vadActive");
    expect(serialized).not.toContain("playbackActive");
    expect(serialized).not.toContain("native-chat-playback");
  });

  it("keeps remote speaking updates off the capture event", () => {
    vi.mocked(chatVoiceDebug).mockClear();
    const state = {
      isVoiceModeActive: true,
      hasConnectedOnce: true,
      hasVoiceSessionStarted: true,
      hasSpoken: true,
      isUserSpeaking: false,
      isAssistantSpeaking: true,
      isInstantAudioCapturing: false,
      isDuckingActive: false,
      metrics: { numSpeaking: 1 },
      server: {
        connectionState: "connected",
        remoteState: "speaking",
        relayReady: true,
        voiceConnectionQuality: "excellent",
      },
    };
    observeNativeChatVoiceState({ get() {} } as unknown as ChatVoiceScope, {
      SPn: () => ({
        getState: () => state,
        subscribe: () => () => {},
      }),
    });
    const capture = vi
      .mocked(chatVoiceDebug)
      .mock.calls.filter((call) => call[0] === "native-chat-capture")
      .map((call) => call[1]);
    expect(capture).toEqual([
      expect.objectContaining({
        captureActive: false,
        userActorSpeaking: false,
        userInputEvidence: "unknown",
      }),
    ]);
    expect(JSON.stringify(capture)).not.toContain("hasRemoteSpoken");
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-response",
      expect.objectContaining({
        hasRemoteSpoken: true,
        remoteSpeakingUpdates: true,
        remoteMessageProcessed: true,
      }),
    );
    expect(chatVoiceDebug).toHaveBeenCalledWith(
      "native-chat-state",
      expect.objectContaining({
        connectionQuality: "excellent",
        assistantActorSpeaking: true,
        deviceOutput: "unknown",
      }),
    );
    const output = vi
      .mocked(chatVoiceDebug)
      .mock.calls.filter((call) => call[0] === "native-chat-output")
      .map((call) => call[1]);
    expect(JSON.stringify(output)).not.toContain("connectionQuality");
  });
});
