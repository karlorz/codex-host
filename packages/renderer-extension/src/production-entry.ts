import { installNativeChatVoiceHook } from "./renderer-native-chat-voice.js";
import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installClientOwnedVoiceHook } from "./renderer-client-owned-voice.js";
import { installRendererBinding } from "./install-renderer-binding.js";
import { installExternalVoiceLaunchHook } from "./renderer-external-voice-launch.js";
import { installVoiceCapabilityProjection } from "./renderer-voice-capability.js";
import { installVoiceSettingsExplanation } from "./renderer-voice-settings.js";
import { installRendererRpcSteering } from "./renderer-rpc-steering.js";

Object.defineProperty(window, "__codexhostInstallRpcSteeringV1", {
  configurable: true,
  value(controller: unknown) {
    const state = window as unknown as Record<string, unknown>;
    if (state.__codexhostRpcSteeringV1)
      return window.__codexhostRpcSteeringV1?.controller === controller;
    const routing = window.__codexhostHostRoutingV1;
    if (!routing) return false;
    const cleanup = installRendererRpcSteering(controller);
    if (!cleanup) return false;
    const originalDispose = routing.dispose;
    const dispose = () => {
      cleanup();
      delete state.__codexhostRpcSteeringV1;
      window.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
      if (routing.dispose === dispose) routing.dispose = originalDispose;
      originalDispose.call(routing);
    };
    routing.dispose = dispose;
    state.__codexhostRpcSteeringV1 = {
      controller,
      // A later native Remote Control install replaces this method; the Controller
      // compares it on every tick and releases a displaced wrapper to reinstall.
      forHost: (controller as { forHost: unknown }).forHost,
      release() {
        cleanup();
        delete state.__codexhostRpcSteeringV1;
        window.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
      },
    };
    window.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
    return true;
  },
});

installCpaLiveVoiceHook();
installClientOwnedVoiceHook();
installExternalVoiceLaunchHook();
installNativeChatVoiceHook();
installVoiceCapabilityProjection();
installVoiceSettingsExplanation();

const installBinding = (): void => {
  installRendererBinding();
};

if (document.documentElement && document.body) {
  installBinding();
} else {
  window.addEventListener("DOMContentLoaded", installBinding, { once: true });
}
