import {
  gatewayVoiceStartRequest,
  hashedOverlayVoiceStarterFibers,
  wrapGatewayVoiceStarter,
} from "./renderer-voice-start-capability.js";
import {
  bindVoiceCapabilitySubscriptions,
  hashedVoiceCapabilityFamilies,
  replayHashedWorkAccessCapability,
  resolveDerivedAccessAtom,
  type VoiceCapabilityProject,
} from "./renderer-voice-capability.js";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import type { HashedWebpackRequire } from "./renderer-hashed-native-chat-voice.js";
import { isAvatarOverlayHref } from "./renderer-overlay-thread-isolation.js";
import {
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
} from "./renderer-cpa-live-voice-preference.js";
import { workVoiceLaneEnabled, workVoiceUserFacingUnavailable } from "./renderer-voice-evidence.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object";
type Start = (...args: unknown[]) => unknown;
type Binding = { dispose(): void; current(): boolean };
type StarterTarget = object & {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  document?: ParentNode;
  location?: { href?: string };
};
const OVERLAY_CAPABILITY = "__codexhostVoiceCapabilityV1";
const CAPABILITY_RETRY_MS = 1_000;
const COMMIT_POLL_MS = 50;
const COMMIT_POLLS = 40;

/** Starters read the committed subscription owned by the current capability handle. */
function committedCapability(target: StarterTarget): Binding | undefined {
  const capability = (target as RecordValue)[OVERLAY_CAPABILITY];
  if (
    !record(capability) ||
    capability.status !== "active" ||
    typeof capability.current !== "function" ||
    typeof capability.dispose !== "function"
  )
    return;
  return capability as unknown as Binding;
}

/** Resolve the evidence lane from the request's selected collaboration model. */
function workLane(request: unknown): "work-codex" | "work-grok" {
  const mode = record(request) ? request.activeCollaborationMode : undefined;
  const settings = record(mode) ? mode.settings : undefined;
  const model = record(settings) ? settings.model : undefined;
  return typeof model === "string" && model.startsWith("codexhost/") ? "work-grok" : "work-codex";
}

/** Hashed 26.1106 Work Instant Connect starts after the committed capability snapshot. */
export function hashedGatewayStarterOptions(
  target: StarterTarget,
  workGateway: () => boolean = () => cpaLiveVoicePreferenceAllowsInstall(target),
  chatGateway: () => boolean = () => chatLiveVoicePreferenceAllowsOverride(target),
  external: () => boolean = () => false,
) {
  const configured = (request: unknown) =>
    gatewayVoiceStartRequest(
      request,
      workGateway(),
      chatGateway(),
      external() || workLane(request) === "work-grok",
    );
  return {
    configured,
    qualifies: (request: unknown) => {
      const lane = workLane(request);
      return gatewayVoiceStartRequest(
        request,
        lane === "work-codex" && workGateway() && workVoiceLaneEnabled(target, "work-codex"),
        chatGateway(),
        lane === "work-grok" && workVoiceLaneEnabled(target, "work-grok"),
      );
    },
    unavailable: (request: unknown) => workVoiceUserFacingUnavailable(target, workLane(request)),
    ready: async () => {
      for (let i = 0; i < COMMIT_POLLS; i += 1) {
        const client = (target as RecordValue).__codexhostClientOwnedVoiceV1;
        if (
          record(client) &&
          client.status === "active" &&
          committedCapability(target) !== undefined
        )
          return true;
        await new Promise((resolve) => target.setTimeout(resolve, COMMIT_POLL_MS));
      }
      return false;
    },
    prepare: async () => {
      const capability = committedCapability(target);
      if (!capability) throw new Error("Overlay voice capability is not ready");
      return {
        // The capability install owns the subscription; a start only reads it.
        dispose() {},
        current: () =>
          (target as RecordValue)[OVERLAY_CAPABILITY] === capability && capability.current(),
      };
    },
    committed: async (binding: Binding) => {
      for (let i = 0; i < COMMIT_POLLS && !binding.current(); i += 1)
        await new Promise((resolve) => target.setTimeout(resolve, COMMIT_POLL_MS));
    },
  };
}

/** Overlay Compact Voice registers a starter after hashed Work Instant Connect. */
export function wrapHashedOverlayRealtimeStarter(
  services: RecordValue,
  target: StarterTarget,
): (() => void) | undefined {
  const original = services.realtimeVoiceRuntime;
  if (!record(original) && typeof original !== "function") return;
  const register = Reflect.get(original, "registerRealtimeStarter");
  const unregister = Reflect.get(original, "unregisterRealtimeStarter");
  if (typeof register !== "function") return;
  const wrappers = new Set<ReturnType<typeof wrapGatewayVoiceStarter>>();
  const options = hashedGatewayStarterOptions(target);
  const wrapped = new Proxy(original as object, {
    get(service, key, receiver) {
      if (key === "registerRealtimeStarter")
        return (start: Start, cancel: Start, ...rest: unknown[]) => {
          if (typeof start !== "function" || typeof cancel !== "function")
            throw new Error("Voice starter callback unavailable");
          const wrapper = wrapGatewayVoiceStarter(start, options);
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
      if (key === "unregisterRealtimeStarter" && typeof unregister === "function")
        return (...args: unknown[]) => {
          for (const wrapper of wrappers) wrapper.cancel();
          wrappers.clear();
          return Reflect.apply(unregister, original, args);
        };
      return Reflect.get(service, key, receiver);
    },
  });
  if (!Reflect.set(services, "realtimeVoiceRuntime", wrapped)) return;
  return () => {
    for (const wrapper of wrappers) wrapper.cancel();
    wrappers.clear();
    if (services.realtimeVoiceRuntime === wrapped) services.realtimeVoiceRuntime = original;
  };
}

/** Compact Voice Instant Connect reads overlay fibers, not the main Work composer.
 * Bind hashed Work access-replay here so native start can POST /wham. Desktop
 * mounts these fibers, activates the client hook and enables the preference
 * after injection, so the owned binding retries and rebinds a replaced surface.
 */
export function installHashedOverlayWorkCapability(
  target: StarterTarget,
  req: HashedWebpackRequire,
): (() => void) | undefined {
  const href = target.location?.href ?? "";
  if (!isAvatarOverlayHref(href) || !target.document) return;
  const document = target.document as Document;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let binding: ReturnType<typeof bindVoiceCapabilitySubscriptions> | undefined;
  const handle = {
    status: "pending",
    reason: "access-replay",
    current: () => binding?.current() === true,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) target.clearTimeout(timer);
      binding?.dispose();
      binding = undefined;
      if ((target as RecordValue)[OVERLAY_CAPABILITY] === handle)
        Reflect.deleteProperty(target as RecordValue, OVERLAY_CAPABILITY);
    },
  };
  (target as RecordValue)[OVERLAY_CAPABILITY] = handle;
  const allowed = () => {
    const client = (target as RecordValue).__codexhostClientOwnedVoiceV1;
    return (
      record(client) &&
      client.status === "active" &&
      (cpaLiveVoicePreferenceAllowsInstall(target) || workVoiceLaneEnabled(target, "work-grok"))
    );
  };
  const attempt = () => {
    if (disposed) return;
    const families = hashedVoiceCapabilityFamilies(req);
    if (!families || "reason" in families) {
      handle.status = "pending";
      timer = target.setTimeout(attempt, CAPABILITY_RETRY_MS);
      return;
    }
    if (!binding || !binding.current()) {
      binding?.dispose();
      binding = undefined;
      try {
        const project: VoiceCapabilityProject = ({ store, atom, node, chain }) => {
          const access = resolveDerivedAccessAtom(families.access, node, chain);
          return access ? replayHashedWorkAccessCapability(store, atom, access) : null;
        };
        binding = bindVoiceCapabilitySubscriptions(
          () => hashedOverlayVoiceStarterFibers(document),
          families.family,
          families.gates,
          allowed,
          true,
          ["voice.realtime", "voice.thread"],
          project,
        );
      } catch {
        binding = undefined;
      }
    }
    if (binding?.projectedCapable() === true) {
      if (handle.status !== "active") {
        handle.status = "active";
        chatVoiceDebug("voice-capability", { status: "active", reason: "access-replay" });
      }
    } else handle.status = "pending";
    timer = target.setTimeout(attempt, CAPABILITY_RETRY_MS);
  };
  attempt();
  return handle.dispose;
}
