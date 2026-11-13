import { installNativeChatVoiceHook } from "./renderer-native-chat-voice.js";

const existing = Reflect.get(globalThis, "__codexhostNativeChatVoiceV1") as
  { dispose?: () => void } | undefined;
existing?.dispose?.();
installNativeChatVoiceHook();
