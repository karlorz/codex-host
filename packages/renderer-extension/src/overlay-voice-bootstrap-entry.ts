import { installHashedOverlayVoiceHook } from "./renderer-hashed-overlay-voice.js";
import {
  installHashedOverlayWorkCapability,
  wrapHashedOverlayRealtimeStarter,
} from "./renderer-hashed-gateway-start.js";
import { isAvatarOverlayHref } from "./renderer-overlay-thread-isolation.js";
import { HASHED_WEBPACK_VOICE_RUNTIME_ASSET } from "./renderer-voice-profiles.js";
import type { HashedWebpackRequire } from "./renderer-hashed-native-chat-voice.js";

type RecordValue = Record<string, unknown>;
type Disposer = () => void;

const BOOTSTRAP_GLOBAL = "__codexhostOverlayVoiceBootstrapV1";
/** A reinjected bundle replaces this bootstrap instead of stacking wraps. */
const BOOTSTRAP_VERSION = "hashed-overlay-voice-bootstrap-v1";

type OverlayBootstrapTarget = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  document?: ParentNode;
  location?: { href?: string };
};

export interface OverlayVoiceBootstrap {
  version: string;
  dispose(): void;
}

/** One owned bootstrap per overlay document. Reinjection disposes the previous
 * hooks in reverse install order, so proxies and bindings cannot accumulate. */
export function installOverlayVoiceBootstrap(
  target: OverlayBootstrapTarget,
  options: { importRuntime?: (url: string) => Promise<RecordValue> } = {},
): OverlayVoiceBootstrap | undefined {
  if (!isAvatarOverlayHref(target.location?.href ?? "") || !target.document) return;
  const previous = Reflect.get(target, BOOTSTRAP_GLOBAL) as
    Partial<OverlayVoiceBootstrap> | undefined;
  if (typeof previous?.dispose === "function") previous.dispose();
  else
    (
      Reflect.get(target, "__codexhostClientOwnedVoiceV1") as { dispose?: () => void } | undefined
    )?.dispose?.();

  const disposers: Disposer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        disposer();
      } catch {
        /* A failed child must not retain the rest. */
      }
    }
    if (Reflect.get(target, BOOTSTRAP_GLOBAL) === handle)
      Reflect.deleteProperty(target, BOOTSTRAP_GLOBAL);
  };
  const handle: OverlayVoiceBootstrap = { version: BOOTSTRAP_VERSION, dispose };
  Reflect.set(target, BOOTSTRAP_GLOBAL, handle);
  const importRuntime = options.importRuntime ?? ((url: string) => import(url));
  // Compact Voice Chat starts on an already-loaded overlay document. Evaluating
  // the full overlay hook IIFE here stalls native /wham. This entry only waits
  // for hashed 348410, then wraps WebFetch on a microtask.
  queueMicrotask(() => {
    if (disposed) return;
    const hook = installHashedOverlayVoiceHook({ target });
    disposers.push(() => hook.dispose());
    void importRuntime(`app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}`)
      .then((runtime) => {
        if (disposed) return;
        const req = runtime.__webpack_require__ as HashedWebpackRequire | undefined;
        if (typeof req !== "function") return;
        const ga = req("GaA7");
        const services =
          ga && typeof ga === "object" ? (ga as { appServices?: object }).appServices : undefined;
        if (services && typeof services === "object") {
          const restore = wrapHashedOverlayRealtimeStarter(services as RecordValue, target);
          if (restore) disposers.push(restore);
        }
        const disposeCapability = installHashedOverlayWorkCapability(target, req);
        if (disposeCapability) disposers.push(disposeCapability);
      })
      .catch(() => undefined);
  });
  return handle;
}

installOverlayVoiceBootstrap(globalThis);
