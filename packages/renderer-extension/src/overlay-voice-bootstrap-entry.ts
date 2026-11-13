import { installHashedOverlayVoiceHook } from "./renderer-hashed-overlay-voice.js";

const existing = Reflect.get(globalThis, "__codexhostClientOwnedVoiceV1") as
  { dispose?: () => void } | undefined;
existing?.dispose?.();

// Compact Voice Chat starts on an already-loaded overlay document. Evaluating
// the full overlay hook IIFE here stalls native /wham. This entry only waits
// for hashed 348410, then wraps WebFetch on a microtask.
queueMicrotask(() => {
  installHashedOverlayVoiceHook();
});
