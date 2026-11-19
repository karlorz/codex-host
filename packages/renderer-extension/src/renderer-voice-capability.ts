import { selectVoiceAssets, supportsVoiceVersion } from "./renderer-voice-assets.js";
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import {
  CLIENT_OWNED_VOICE_ASSETS,
  isExternalHarnessComposer,
  isWorkComposerSurface,
} from "./renderer-client-owned-voice.js";
import {
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  hashedVoiceProfileSupported,
  voiceImplementationRevision,
  type VoiceCapabilityReason,
} from "./renderer-voice-profiles.js";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import { resolveHashedWebpackRequire } from "./renderer-hashed-native-chat-voice.js";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-hook.js";
import {
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
  voiceGatewayIsReady,
} from "./renderer-cpa-live-voice-preference.js";
import { workVoiceLaneEnabled } from "./renderer-voice-evidence.js";

import {
  bindVoiceCapabilitySubscriptions,
  hashedVoiceCapabilityFamilies,
  initializeVoiceCapabilityFamilies,
  replayHashedWorkAccessCapability,
  resolveDerivedAccessAtom,
  type VoiceCapabilityProject,
} from "./renderer-voice-capability-subscriptions.js";
export {
  INFERENCE_GATE,
  bindVoiceCapabilitySubscriptions,
  hashedVoiceCapabilityFamilies,
  hooks,
  initializeVoiceCapabilityFamilies,
  isDerivedAccessFactory,
  isReadableCapabilityFamily,
  isSignalGateFamily,
  replayHashedWorkAccessCapability,
  replayVoiceCapability,
  resolveDerivedAccessAtom,
  type VoiceCapabilityProject,
} from "./renderer-voice-capability-subscriptions.js";
const GLOBAL = "__codexhostVoiceCapabilityV1";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object";

function composerFibers(composer: Element, chat = false): Set<RecordValue> {
  const fibers = new Set<RecordValue>();
  const rootKey = Object.getOwnPropertyNames(composer).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  const ancestors = rootKey
    ? committedReactAncestors(Object.getOwnPropertyDescriptor(composer, rootKey)?.value)
    : [];
  let root = ancestors[0];
  if (chat) {
    // Chat's native realtime hook lives on the form's owning component.
    const owners = ancestors.filter(
      ({ memoizedProps: props }) =>
        record(props) &&
        props.isWorkConversation === false &&
        props.isTemporaryChat === false &&
        props.shouldBlockExternalEgress === false &&
        props.readOnly !== true &&
        typeof props.conversationId === "string" &&
        record(props.composerSelectionContext) &&
        props.composerSelectionContext.conversationId === props.conversationId,
    );
    if (owners.length !== 1) return fibers;
    root = owners[0];
  }
  if (!root) return fibers;
  for (const element of [composer, ...composer.querySelectorAll("*")].slice(0, 2048)) {
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    if (!key) continue;
    const ancestors = committedReactAncestors(Object.getOwnPropertyDescriptor(element, key)?.value);
    const boundary = ancestors.indexOf(root);
    if (boundary < 0) continue;
    for (const fiber of ancestors.slice(0, boundary + 1)) if (record(fiber)) fibers.add(fiber);
  }
  return fibers;
}

/** The native family memo binds the capability cache key, AppScope chain and
 * signal to the same component's useSyncExternalStore subscription. Only local
 * voice.realtime / voice.thread members within the Composer qualify.
 */
export function bindComposerVoiceCapability(
  composer: Element,
  family: Parameters<typeof bindVoiceCapabilitySubscriptions>[1],
  gates: Parameters<typeof bindVoiceCapabilitySubscriptions>[2],
  allowed: () => boolean,
  chat = false,
  project?: VoiceCapabilityProject,
): { dispose(): void; current(): boolean; projectedCapable(): boolean } {
  return bindVoiceCapabilitySubscriptions(
    () => composerFibers(composer, chat),
    family,
    gates,
    allowed,
    false,
    ["voice.realtime", "voice.thread"],
    project,
  );
}

interface Target {
  [key: string]: unknown;
  document?: Document;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export function installVoiceCapabilityProjection(
  options: {
    target?: Target;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): { status: string; reason?: VoiceCapabilityReason; current?(): boolean; dispose(): void } {
  const target = options.target ?? (globalThis as unknown as Target);
  const revision = voiceImplementationRevision();
  const existing = target[GLOBAL] as
    { status: string; dispose(): void; revision?: string } | undefined;
  if (existing) {
    if (existing.revision === revision) return existing;
    existing.dispose();
  }
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config) return { status: "disabled", reason: "disabled", dispose() {} };
  const hashed = hashedVoiceProfileSupported(config);
  if (!hashed && !supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, config.desktopVersion))
    return { status: "unsupported", reason: "unsupported", dispose() {} };
  let timer: ReturnType<typeof setTimeout>;
  let binding: ReturnType<typeof bindComposerVoiceCapability> | undefined;
  let composer: Element | undefined;
  let disposed = false;
  const handle = {
    status: "pending",
    reason: "pending" as VoiceCapabilityReason,
    revision,
    current() {
      return !disposed && allowed() && binding?.current() === true;
    },
    dispose() {
      disposed = true;
      target.clearTimeout(timer);
      binding?.dispose();
      if (target[GLOBAL] === handle) Reflect.deleteProperty(target, GLOBAL);
    },
  };
  let lastDiag = "";
  const diagnose = (status: string, reason: VoiceCapabilityReason) => {
    handle.status = status;
    handle.reason = reason;
    const key = `${status}:${reason}`;
    if (lastDiag === key) return;
    lastDiag = key;
    chatVoiceDebug("voice-capability", { status, reason });
  };
  target[GLOBAL] = handle;
  const hookActive = (key: string) => {
    const hook = target[key];
    return record(hook) && hook.status === "active";
  };
  const currentRoute = () => {
    try {
      const routing = target.__codexhostHostRoutingV1 as RendererHostRouting | undefined;
      const route = routing?.forComposer();
      return route?.hostId === "local" && routing?.forHost("local") === route ? route : undefined;
    } catch {
      return undefined;
    }
  };
  const external = () => {
    try {
      return isExternalHarnessComposer(target);
    } catch {
      return false;
    }
  };
  const chatGateway = () =>
    !isWorkComposerSurface(target) && chatLiveVoicePreferenceAllowsOverride(target);
  const hashedWorkSurface = () => hashed && isWorkComposerSurface(target);
  const allowed = () =>
    !!readCpaLiveVoiceHookConfig(target) &&
    voiceGatewayIsReady(target) &&
    hookActive("__codexhostClientOwnedVoiceV1") &&
    hookActive("__codexhostExternalVoiceLaunchV1") &&
    (chatGateway() ||
      (!!currentRoute() &&
        (isWorkComposerSurface(target) ||
          (external() &&
            target.document?.querySelectorAll("[data-chatgpt-composer]").length === 0)) &&
        (cpaLiveVoicePreferenceAllowsInstall(target) || external()) &&
        (hashedWorkSurface() ||
          (external()
            ? workVoiceLaneEnabled(target, "work-grok")
            : workVoiceLaneEnabled(target, "work-codex")))));
  const visibleComposers = () =>
    [
      ...(target.document?.querySelectorAll(
        chatGateway() ? "[data-chatgpt-composer]" : "[data-codex-composer-root]",
      ) ?? []),
    ].filter(
      (element) =>
        element.getBoundingClientRect().width > 0 && !element.closest("[hidden], [inert]"),
    );
  const bindComposer = (
    next: Element,
    family: Parameters<typeof bindVoiceCapabilitySubscriptions>[1],
    gates: Parameters<typeof bindVoiceCapabilitySubscriptions>[2],
    project?: VoiceCapabilityProject,
  ): ReturnType<typeof bindComposerVoiceCapability> => {
    binding?.dispose();
    binding = undefined;
    composer = next;
    binding = bindComposerVoiceCapability(next, family, gates, allowed, chatGateway(), project);
    return binding;
  };
  const refresh = async () => {
    if (disposed) return;
    try {
      const names = loadedAssetNames(target.document, target.performance);
      const importModule = options.importModule ?? ((url: string) => import(url));
      if (hashed) {
        if (!names.some((name) => name.includes(HASHED_WEBPACK_VOICE_RUNTIME_ASSET))) {
          diagnose("pending", "pending");
        } else if (!allowed()) diagnose("pending", "pending");
        else {
          const req = await resolveHashedWebpackRequire(importModule);
          if (disposed) return;
          const families = req ? hashedVoiceCapabilityFamilies(req) : undefined;
          if (!families) throw new Error("Hashed voice capability families unavailable");
          if ("reason" in families) {
            diagnose("unsupported", families.reason);
            throw new Error("Hashed voice access atom unavailable");
          }
          const composers = visibleComposers();
          if (composers.length !== 1) throw new Error("Voice composer unavailable");
          const hashedWorkProject: VoiceCapabilityProject | undefined =
            hashed && !chatGateway()
              ? ({ store, atom, node, chain }) => {
                  const access = resolveDerivedAccessAtom(families.access, node, chain);
                  return access ? replayHashedWorkAccessCapability(store, atom, access) : null;
                }
              : undefined;
          if (
            composers[0] !== composer ||
            !binding ||
            !binding.current() ||
            (hashedWorkProject && !binding.projectedCapable())
          ) {
            bindComposer(
              composers[0] as Element,
              families.family,
              families.gates,
              hashedWorkProject,
            );
          }
          if (binding?.projectedCapable())
            diagnose("active", hashedWorkProject ? "access-replay" : "inference-replay");
          else
            diagnose("native-ineligible", hashedWorkProject ? "other-denial" : "native-ineligible");
        }
      } else {
        const assets = selectVoiceAssets(
          CLIENT_OWNED_VOICE_ASSETS,
          names,
          config.desktopVersion,
          config.desktopPlatform,
        );
        if (!assets) {
          diagnose("unsupported", "unsupported");
        } else if (!allowed()) diagnose("pending", "pending");
        else {
          const module = await importModule(`app://-/assets/${assets.initial}`);
          if (disposed) return;
          const composers = visibleComposers();
          if (composers.length !== 1) throw new Error("Voice composer unavailable");
          if (
            composers[0] !== composer ||
            !binding ||
            (!binding.current() && binding.projectedCapable())
          ) {
            const { family, gates } = initializeVoiceCapabilityFamilies(module, assets);
            bindComposer(composers[0] as Element, family, gates);
          }
          diagnose(
            binding?.projectedCapable() ? "active" : "native-ineligible",
            binding?.projectedCapable() ? "inference-replay" : "native-ineligible",
          );
        }
      }
    } catch {
      if (handle.status !== "unsupported") diagnose("unsupported", "unsupported");
    }
    if (handle.status !== "active" && handle.status !== "native-ineligible") {
      binding?.dispose();
      binding = undefined;
      composer = undefined;
    }
    if (!disposed) timer = target.setTimeout(() => void refresh(), 1000);
  };
  void refresh();
  return handle;
}
