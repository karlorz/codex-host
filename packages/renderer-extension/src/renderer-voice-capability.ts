import { selectVoiceAssets, supportsVoiceVersion } from "./renderer-voice-assets.js";
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import {
  CLIENT_OWNED_VOICE_ASSETS,
  isExternalHarnessComposer,
  isWorkComposerSurface,
} from "./renderer-client-owned-voice.js";
import {
  HASHED_26_1106_VOICE_EVALUATOR,
  HASHED_OVERLAY_VOICE_ROLES,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  hashedVoiceProfileSupported,
  voiceImplementationRevision,
  type VoiceCapabilityReason,
} from "./renderer-voice-profiles.js";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import {
  resolveHashedWebpackRequire,
  type HashedWebpackRequire,
} from "./renderer-hashed-native-chat-voice.js";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-hook.js";
import {
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
  voiceGatewayIsReady,
} from "./renderer-cpa-live-voice-preference.js";
import { workVoiceLaneEnabled } from "./renderer-voice-evidence.js";

const GLOBAL = "__codexhostVoiceCapabilityV1";
export const INFERENCE_GATE = "3683713372";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object";
type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: unknown };
type Store = { get(atom: Atom): unknown; sub(atom: Atom, listener: () => void): () => void };
interface Subscriber {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  createRender?(): unknown;
}
interface Signal {
  atom: Atom;
  store: Store;
}
interface Instance {
  getSnapshot(): unknown;
}
interface Hook {
  memoizedState?: unknown;
  queue?: unknown;
  next?: Hook | null;
}
interface ScopeNode {
  store: Store;
  familyBindings: Map<Family, Map<string, { cacheKey: unknown }>>;
}
interface Family {
  scope: { id: unknown };
  kind?: string;
  read?: unknown;
  resolve(node: ScopeNode, chain: Map<unknown, unknown>, parameter?: string): { atom: Atom };
}
interface DerivedAccessFactory {
  scope: { id: unknown };
  cache?: unknown;
  createSubscriberAtom: (...args: unknown[]) => unknown;
  resolve(node: ScopeNode, chain: Map<unknown, unknown>): unknown;
}
type Capability = { isLoading: boolean; isError: boolean; isCapable: boolean };
const capable = (value: unknown): value is Capability =>
  record(value) &&
  typeof value.isLoading === "boolean" &&
  typeof value.isError === "boolean" &&
  typeof value.isCapable === "boolean";
const equal = (a: Capability, b: Capability) =>
  a.isLoading === b.isLoading && a.isError === b.isError && a.isCapable === b.isCapable;

/** Replay named-profile capability atoms that AND first-party inference.
 * Hashed 26.1106 `voice` / `voice.realtime` leave `requiresFirstPartyInference`
 * at its default false, so this replay is not that evaluator. Native atoms,
 * provider config and Statsig retain their values. This path never writes
 * `model_provider` and never flips Statsig gate 3683713372.
 */
export function replayVoiceCapability(store: Store, atom: Atom, gate: Atom): Capability | null {
  const evaluate = (override: boolean) => {
    const visiting = new Set<Atom>();
    let remaining = 512;
    let hits = 0;
    const read = (dependency: Atom): unknown => {
      if (--remaining < 0) throw new Error("Voice capability dependency limit");
      const value = store.get(dependency);
      if (dependency === gate) {
        hits += 1;
        if (typeof value !== "boolean") throw new Error("Voice inference gate unavailable");
        return override ? false : value;
      }
      if (dependency.write || visiting.has(dependency)) return value;
      if (typeof dependency.read !== "function") throw new Error("Voice dependency unavailable");
      visiting.add(dependency);
      try {
        return dependency.read(read);
      } finally {
        visiting.delete(dependency);
      }
    };
    return { value: read(atom), hits };
  };
  try {
    const native = store.get(atom);
    if (!capable(native) || native.isLoading || native.isError) return null;
    const before = evaluate(false);
    if (!capable(before.value) || !equal(native, before.value)) return null;
    const after = evaluate(true);
    return after.hits > 0 && capable(after.value) && !after.value.isLoading && !after.value.isError
      ? after.value
      : null;
  } catch {
    return null;
  }
}

function isFamily(value: unknown): value is Family {
  return record(value) && record(value.scope) && typeof value.resolve === "function";
}

export function isReadableCapabilityFamily(value: unknown): value is Family {
  return isFamily(value) && value.kind === "readable-family" && typeof value.read === "function";
}

export function isSignalGateFamily(value: unknown): value is Family {
  return isFamily(value) && value.kind === "signal-family";
}

/** `zTeN.un` cached derived-atom factory: resolve returns an atom with `.read`.
 * Live hashed 26.1106 `eFn4.Y3` stores a string cache key, not a WeakMap.
 * It is not `zTeN.i1` `readable-family` (ChYf.G). `store.get(factory)` throws.
 */
export function isDerivedAccessFactory(value: unknown): value is DerivedAccessFactory {
  return (
    record(value) &&
    record(value.scope) &&
    (typeof value.cache === "string" || record(value.cache)) &&
    typeof value.resolve === "function" &&
    typeof value.createSubscriberAtom === "function" &&
    typeof value.read !== "function" &&
    value.kind == null
  );
}

function hashedVoiceCapabilityFamilies(
  req: HashedWebpackRequire,
):
  | { family: Family; gates: Family; access: DerivedAccessFactory }
  | { reason: "access-shape" }
  | undefined {
  const roles = HASHED_OVERLAY_VOICE_ROLES;
  let capabilityExports: unknown;
  let gateExports: unknown;
  let accessExports: unknown;
  try {
    capabilityExports = req(roles.capabilityModuleId);
  } catch {
    return;
  }
  try {
    gateExports = req(roles.inferenceGateModuleId);
  } catch {
    return;
  }
  try {
    accessExports = req(roles.voiceAccessModuleId);
  } catch {
    return { reason: "access-shape" };
  }
  const family = record(capabilityExports) ? capabilityExports[roles.capabilityExport] : undefined;
  const gates = record(gateExports) ? gateExports[roles.inferenceGateExport] : undefined;
  const access = record(accessExports) ? accessExports[roles.voiceAccessExport] : undefined;
  if (!isReadableCapabilityFamily(family) || !isSignalGateFamily(gates)) return;
  if (!isDerivedAccessFactory(access)) return { reason: "access-shape" };
  return { family, gates, access };
}

export function resolveDerivedAccessAtom(
  factory: DerivedAccessFactory,
  node: ScopeNode,
  chain: Map<unknown, unknown>,
): Atom | undefined {
  try {
    const resolved = factory.resolve(node, chain);
    if (record(resolved) && typeof resolved.read === "function" && !("atom" in resolved))
      return resolved as unknown as Atom;
    return undefined;
  } catch {
    return undefined;
  }
}

export type VoiceCapabilityProject = (input: {
  native: unknown;
  store: Store;
  atom: Atom;
  gate: Atom;
  node: ScopeNode;
  chain: Map<unknown, unknown>;
}) => Capability | null;

const ALLOWED_ACCESS = { status: "allowed" } as const;

function unsupportedAuthAccess(value: unknown): boolean {
  return (
    record(value) &&
    value.status === "denied" &&
    value.reason === HASHED_26_1106_VOICE_EVALUATOR.unsupportedAuthReason
  );
}

/** Readonly replay of hashed `ChYf.G` substituting only the derived `eFn4.Y3`
 * atom when it is denied `unsupported-auth`. Native-before must match the
 * unsubstituting walk. Statsig, client, `in_app_voice`, host access, loading
 * and error stay native. Never writes Y3, ZnQ7, Statsig or `model_provider`.
 */
export function replayHashedWorkAccessCapability(
  store: Store,
  atom: Atom,
  access: Atom,
): Capability | null {
  const evaluate = (override: boolean) => {
    const visiting = new Set<Atom>();
    let remaining = 512;
    let hits = 0;
    const read = (dependency: Atom): unknown => {
      if (--remaining < 0) throw new Error("Voice capability dependency limit");
      const value = store.get(dependency);
      if (dependency === access) {
        hits += 1;
        if (override && unsupportedAuthAccess(value)) return ALLOWED_ACCESS;
        return value;
      }
      if (dependency.write || visiting.has(dependency)) return value;
      if (typeof dependency.read !== "function") throw new Error("Voice dependency unavailable");
      visiting.add(dependency);
      try {
        return dependency.read(read);
      } finally {
        visiting.delete(dependency);
      }
    };
    return { value: read(atom), hits };
  };
  try {
    const native = store.get(atom);
    if (!capable(native) || native.isLoading || native.isError) return null;
    const before = evaluate(false);
    if (!capable(before.value) || !equal(native, before.value)) return null;
    if (native.isCapable) return native;
    const after = evaluate(true);
    return after.hits > 0 &&
      capable(after.value) &&
      !after.value.isLoading &&
      !after.value.isError &&
      after.value.isCapable
      ? after.value
      : null;
  } catch {
    return null;
  }
}

/** Family.resolve accepts arbitrary keys, so probing unrelated families cannot
 * identify the inference gate. Only the selected asset profile owns these exports.
 */
export function initializeVoiceCapabilityFamilies(
  module: RecordValue,
  assets: { capabilityInit: string; capabilityFamily: string; inferenceGateFamily: string },
): { family: Family; gates: Family } {
  const initialize = module[assets.capabilityInit];
  if (typeof initialize !== "function") throw new Error("Voice capability initializer unavailable");
  initialize();
  const family = module[assets.capabilityFamily];
  const gates = module[assets.inferenceGateFamily];
  if (!isFamily(family) || !isFamily(gates))
    throw new Error("Voice capability families unavailable");
  return { family, gates };
}

export function hooks(fiber: RecordValue): Hook[] {
  const result: Hook[] = [];
  const seen = new Set<unknown>();
  let hook = fiber.memoizedState;
  while (record(hook) && result.length < 4096 && !seen.has(hook)) {
    seen.add(hook);
    result.push(hook as Hook);
    hook = hook.next;
  }
  return hook == null ? result : [];
}

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
  family: Family,
  gates: Family,
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

/** Subscription ownership is supplied by the version-qualified surface owner. */
export function bindVoiceCapabilitySubscriptions(
  currentFibers: () => Set<RecordValue>,
  family: Family,
  gates: Family,
  allowed: () => boolean,
  realtimeOnly = false,
  names: readonly (
    "voice.realtime" | "voice.thread" | "dictation.composer" | "dictation.global"
  )[] = ["voice.realtime", "voice.thread"],
  project?: VoiceCapabilityProject,
): { dispose(): void; current(): boolean; projectedCapable(): boolean } {
  const fibers = currentFibers();
  const restores: (() => void)[] = [];
  const bindings: { subscriber: Subscriber; signal: Signal; instance: Instance }[] = [];
  try {
    for (const fiber of fibers) {
      const list = hooks(fiber);
      for (const memo of list) {
        const [signal, deps] = Array.isArray(memo.memoizedState) ? memo.memoizedState : [];
        if (
          !record(signal) ||
          !Array.isArray(deps) ||
          deps.length !== 5 ||
          deps[3] !== family ||
          !(deps[1] instanceof Map) ||
          deps[2] !== undefined
        )
          continue;
        const chain = deps[1] as Map<unknown, unknown>;
        const node = chain.get(family.scope.id) as ScopeNode | undefined;
        const members = node?.familyBindings?.get(family);
        if (!node || !(members instanceof Map) || node.store !== signal.store) continue;
        const matches = [...members].filter(([, member]) => member.cacheKey === deps[0]);
        if (matches.length !== 1 || typeof matches[0]?.[0] !== "string") continue;
        const parameter = JSON.parse(matches[0][0]);
        if (
          !record(parameter) ||
          Object.keys(parameter).some((key) => key !== "name" && key !== "hostId") ||
          !names.some((name) => parameter.name === name) ||
          (realtimeOnly && parameter.name !== "voice.realtime") ||
          (parameter.hostId !== undefined && parameter.hostId !== "local") ||
          (parameter.name === "voice.thread" && parameter.hostId !== "local")
        )
          continue;
        const subscriptions = list.filter((hook) => {
          const state = hook.memoizedState;
          return (
            Array.isArray(state) &&
            Array.isArray(state[1]) &&
            state[1].length === 2 &&
            state[1][0] === signal &&
            state[1][1] === undefined &&
            typeof state[0]?.getSnapshot === "function"
          );
        });
        if (subscriptions.length !== 1) throw new Error("Ambiguous voice subscription");
        const hook = subscriptions[0] as Hook;
        const subscriber = (hook.memoizedState as unknown[])[0] as Subscriber;
        const instance = hook.next?.queue as Instance | undefined;
        const effect = hook.next?.next?.memoizedState;
        const store = signal.store as Store;
        const gate = gates.resolve(node, chain, INFERENCE_GATE)?.atom;
        if (
          !gate ||
          !instance ||
          !record(effect) ||
          !Array.isArray(effect.deps) ||
          effect.deps[0] !== subscriber.subscribe ||
          typeof effect.create !== "function" ||
          typeof instance.getSnapshot !== "function" ||
          !capable(store.get(signal.atom as Atom)) ||
          !capable(subscriber.getSnapshot()) ||
          !capable(instance.getSnapshot()) ||
          !equal(
            store.get(signal.atom as Atom) as Capability,
            subscriber.getSnapshot() as Capability,
          ) ||
          !equal(subscriber.getSnapshot() as Capability, instance.getSnapshot() as Capability) ||
          subscriber.createRender?.() != null
        )
          throw new Error("Unsupported voice subscription");
        for (const [object, key] of [
          [store, "sub"],
          [subscriber, "getSnapshot"],
          [instance, "getSnapshot"],
        ] as const)
          if (Object.getOwnPropertyDescriptor(object, key)?.writable !== true)
            throw new Error("Voice subscription is not writable");
        let notify: (() => void) | undefined;
        const sub = store.sub;
        try {
          store.sub = (atom, listener) => {
            if (atom !== signal.atom || notify) throw new Error("Unexpected voice subscription");
            notify = listener;
            return () => {};
          };
          effect.create();
        } finally {
          store.sub = sub;
        }
        if (!notify) throw new Error("Voice listener unavailable");
        const original = subscriber.getSnapshot;
        const originalInstance = instance.getSnapshot;
        let previous: Capability | undefined;
        const snapshot = () => {
          const native = original.call(subscriber);
          if (!allowed()) return native;
          const projected = project
            ? project({
                native,
                store,
                atom: signal.atom as Atom,
                gate,
                node,
                chain,
              })
            : replayVoiceCapability(store, signal.atom as Atom, gate);
          if (!projected || !projected.isCapable) return native;
          if (!previous || !equal(previous, projected)) previous = projected;
          return previous;
        };
        subscriber.getSnapshot = snapshot;
        instance.getSnapshot = snapshot;
        const onChange = notify;
        restores.push(() => {
          if (subscriber.getSnapshot === snapshot) subscriber.getSnapshot = original;
          if (instance.getSnapshot === snapshot) instance.getSnapshot = originalInstance;
          onChange();
        });
        bindings.push({ subscriber, signal: signal as unknown as Signal, instance });
        onChange();
      }
    }
    if (!restores.length) throw new Error("Owned voice capability unavailable");
    if (realtimeOnly && restores.length !== 1) throw new Error("Ambiguous voice starter");
  } catch (error) {
    for (const restore of restores.reverse()) restore();
    throw error;
  }
  const alignedSnapshot = ({ subscriber, instance }: (typeof bindings)[number]) => {
    try {
      const snapshot = subscriber.getSnapshot();
      const instanceSnapshot = instance.getSnapshot();
      if (!capable(snapshot) || !capable(instanceSnapshot) || !equal(snapshot, instanceSnapshot))
        return undefined;
      return snapshot;
    } catch {
      return undefined;
    }
  };
  return {
    dispose() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
    current() {
      const current = [...currentFibers()].flatMap(hooks);
      return bindings.every((binding) => {
        const snapshot = alignedSnapshot(binding);
        if (!snapshot) return false;
        const { subscriber, signal, instance } = binding;
        return current.some((hook) => {
          const committed = hook.next?.memoizedState;
          return (
            Array.isArray(hook.memoizedState) &&
            hook.memoizedState[0] === subscriber &&
            hook.memoizedState[1]?.[0] === signal &&
            hook.next?.queue === instance &&
            capable(committed) &&
            equal(committed, snapshot) &&
            (!realtimeOnly || snapshot.isCapable)
          );
        });
      });
    },
    projectedCapable() {
      return (
        bindings.length > 0 &&
        bindings.every((binding) => alignedSnapshot(binding)?.isCapable === true)
      );
    },
  };
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
): { status: string; reason?: VoiceCapabilityReason; dispose(): void } {
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
    family: Family,
    gates: Family,
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
