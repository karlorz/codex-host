import { committedReactAncestors } from "@codexhost/desktop-control/renderer-react-ownership";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-config.js";
import { rememberVoiceProductExperience } from "./renderer-voice-gateway-wrap.js";
import { nativeChatVoicePreferenceAllowsStart } from "./renderer-voice-routes-cache.js";
import { nativeChatVoiceDraftSelection } from "./renderer-native-chat-voice-selection.js";
import {
  alignNativeChatVoiceButton,
  hideNativeChatVoiceHomeHeadline,
} from "./renderer-native-chat-voice-presentation.js";
import { chatVoiceQualified } from "./renderer-voice-evidence.js";
import {
  createNativeChatPrepareBudget,
  hashedNativeChatGraphReady,
  loadNativeChatVoiceGraph,
  mountNativeChatVoiceRuntime,
  nativeChatVoiceSessionLive,
  observeNativeChatVoiceConnection,
  readNativeChatVoiceObservedState,
  selectNativeChatVoiceAdapter,
  startNativeChatVoiceSession,
  type NativeChatVoiceModules as NativeChatVoiceGraph,
  type NativeChatVoiceStartObservation,
} from "./renderer-native-chat-voice-runtime.js";

const HOOK_GLOBAL = "__codexhostNativeChatVoiceV1";
const BUTTON = "data-codexhost-chat-voice-start";
const CONVERSATION_UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object";

export interface ChatVoiceScope {
  scope: unknown;
  node: unknown;
  chain: Map<unknown, unknown>;
  get(selector: unknown, argument?: unknown): unknown;
  set(selector: unknown, value: unknown): void;
}
export interface NativeChatVoiceBinding {
  composer: Element;
  appNode: object;
  props: RecordValue & { conversationId: string };
  scope: ChatVoiceScope;
  context: unknown;
  composerContext: { context: unknown; chain: Map<unknown, unknown> };
  backendConversationId: string | undefined;
}
interface NativeChatVoiceModules {
  scopeDefinition: { id: unknown; __scopeBrand: string };
  ownerScopeDefinition: { id: unknown; __scopeBrand: string };
  backendConversationId: unknown;
  composerScopeDefinition: { id: unknown; __scopeBrand: string };
}

function scopeRefs(owner: RecordValue, definition: { id: unknown }): Map<unknown, ChatVoiceScope> {
  const scopes = new Map<unknown, ChatVoiceScope>();
  let hook = owner.memoizedState;
  const seen = new Set<unknown>();
  while (record(hook) && seen.size < 4096 && !seen.has(hook)) {
    seen.add(hook);
    const state = hook.memoizedState;
    const scope = record(state) ? state.current : undefined;
    if (
      record(scope) &&
      scope.scope === definition &&
      typeof scope.get === "function" &&
      typeof scope.set === "function" &&
      scope.chain instanceof Map &&
      scope.chain.get(definition.id) === scope.node
    )
      scopes.set(scope.node, scope as unknown as ChatVoiceScope);
    hook = hook.next;
  }
  return hook == null ? scopes : new Map();
}

/** Resolve the native RouteScope ref and its AppScope/inner ComposerScope chain.
 * A Codex locator or Thread-Id is never a Chat ID.
 */
export function detectNativeChatVoiceBinding(
  composer: Element,
  native: NativeChatVoiceModules,
): NativeChatVoiceBinding | undefined {
  const key = Object.getOwnPropertyNames(composer).find((key) => key.startsWith("__reactFiber$"));
  if (!key) return;
  const ancestors = committedReactAncestors(Object.getOwnPropertyDescriptor(composer, key)?.value);
  for (const owner of ancestors) {
    const props = owner.memoizedProps;
    if (
      !record(props) ||
      typeof props.isWorkConversation !== "boolean" ||
      typeof props.isTemporaryChat !== "boolean" ||
      typeof props.conversationId !== "string"
    )
      continue;
    if (
      props.isWorkConversation ||
      props.isTemporaryChat ||
      props.shouldBlockExternalEgress !== false ||
      props.readOnly === true ||
      !record(props.composerSelectionContext) ||
      props.composerSelectionContext.conversationId !== props.conversationId
    )
      return;
    const scopes = scopeRefs(owner, native.ownerScopeDefinition);
    if (scopes.size !== 1) return;
    const scope = [...scopes.values()][0];
    if (!scope) return;
    const appNode = scope.chain.get(native.scopeDefinition.id);
    if (!record(appNode)) return;
    let backendId: unknown;
    try {
      backendId = scope.get(native.backendConversationId, props.conversationId);
    } catch {
      backendId = undefined;
    }
    // A local-chatgpt locator is never a backend ChatGPT UUID.
    if (typeof backendId === "string" && backendId.startsWith("local-chatgpt:"))
      backendId = undefined;
    let hasBackendId = typeof backendId === "string" && CONVERSATION_UUID.test(backendId);
    // Native drafts have a local locator until voice or a message creates the Chat.
    // START accepts an absent backend ID and owns conversation creation.
    const isDraft =
      backendId == null &&
      props.conversationId.startsWith("local-chatgpt:") &&
      CONVERSATION_UUID.test(props.conversationId.slice("local-chatgpt:".length));
    if (!hasBackendId && !isDraft && CONVERSATION_UUID.test(props.conversationId)) {
      hasBackendId = true;
      backendId = props.conversationId;
    }
    if (!hasBackendId && !isDraft) return;
    // The owner creates this provider below itself. Its own subscriptions can
    // still consume the outer home/new ComposerScope, which does not own the form.
    const provider = ancestors
      .slice(0, ancestors.indexOf(owner))
      .find(
        (fiber) =>
          fiber.tag === 10 &&
          record(fiber.type) &&
          fiber.type.displayName === native.composerScopeDefinition.__scopeBrand,
      );
    if (!provider) return;
    const composerChain = record(provider.memoizedProps) ? provider.memoizedProps.value : undefined;
    const composerNode =
      composerChain instanceof Map
        ? composerChain.get(native.composerScopeDefinition.id)
        : undefined;
    if (
      !(composerChain instanceof Map) ||
      composerChain.get(native.scopeDefinition.id) !== appNode ||
      composerChain.get(native.ownerScopeDefinition.id) !== scope.node ||
      !record(composerNode) ||
      composerNode.token !== native.composerScopeDefinition ||
      !record(composerNode.value) ||
      composerNode.value.kind !== "chatgpt" ||
      !record(composerNode.value.chatGptSelectionContext) ||
      composerNode.value.chatGptSelectionContext.conversationId !== props.conversationId
    )
      return;
    const composerContext = { context: provider.type, chain: composerChain };
    const contexts = new Set<unknown>();
    for (const fiber of ancestors) {
      let dependency = record(fiber.dependencies) ? fiber.dependencies.firstContext : undefined;
      const seenDependencies = new Set<unknown>();
      while (
        record(dependency) &&
        seenDependencies.size < 4096 &&
        !seenDependencies.has(dependency)
      ) {
        seenDependencies.add(dependency);
        const context = dependency.context;
        const chain = dependency.memoizedValue;
        if (
          record(context) &&
          context.displayName === native.scopeDefinition.__scopeBrand &&
          chain instanceof Map &&
          chain.get(native.scopeDefinition.id) === appNode
        )
          contexts.add(context);
        dependency = dependency.next;
      }
    }
    if (contexts.size !== 1) return;
    return {
      composer,
      appNode,
      props: props as NativeChatVoiceBinding["props"],
      scope,
      context: [...contexts][0],
      composerContext,
      backendConversationId: hasBackendId ? (backendId as string) : undefined,
    };
  }
}

interface ChatVoiceHook {
  readonly activeCall?: boolean;
  status: "disabled" | "pending" | "active" | "unsupported";
  start(): Promise<NativeChatVoiceStartObservation | undefined>;
  dispose(): void;
}
interface ChatVoiceTarget {
  [key: string]: unknown;
  document?: Document;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** Chat starts use the browser Chat runtime owned by the bound composer. */
export function startNativeChatVoiceForRequest(
  request: unknown,
  target: object = globalThis,
): Promise<NativeChatVoiceStartObservation | undefined> | undefined {
  if (
    !record(request) ||
    request.productExperience !== "chat" ||
    !nativeChatVoicePreferenceAllowsStart(target)
  )
    return;
  const hook = (target as RecordValue)[HOOK_GLOBAL] as ChatVoiceHook | undefined;
  if (hook?.status !== "active") return;
  return hook.start();
}

/** Overlay re-injection disposes the native hook only when no call is active. */
export function replaceNativeChatVoiceHookIfInactive(
  options: {
    target?: ChatVoiceTarget;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): ChatVoiceHook {
  const target = options.target ?? (globalThis as unknown as ChatVoiceTarget);
  const existing = target[HOOK_GLOBAL] as ChatVoiceHook | undefined;
  if (existing?.activeCall === true) return existing;
  existing?.dispose?.();
  return installNativeChatVoiceHook(options);
}

/** Desktop browser voice owns serialization, authentication, WM, events and cleanup.
 * aT enables its dormant runtime and native VoiceRoom in the app root. The
 * native cache controller is mounted once per AppScope, not once per selection.
 */
export function installNativeChatVoiceHook(
  options: {
    target?: ChatVoiceTarget;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): ChatVoiceHook {
  const target = options.target ?? (globalThis as unknown as ChatVoiceTarget);
  const existing = target[HOOK_GLOBAL] as ChatVoiceHook | undefined;
  if (existing) return existing;
  const config = readCpaLiveVoiceHookConfig(target);
  const unavailable = (status: "disabled" | "unsupported"): ChatVoiceHook => ({
    status,
    dispose() {},
    start: async () => {
      throw new Error("Native Chat voice is unavailable");
    },
  });
  if (!config) return unavailable("disabled");
  if (!chatVoiceQualified(config)) return unavailable("unsupported");
  const adapter = selectNativeChatVoiceAdapter(config);
  const hashed = adapter === "hashed";
  if (!adapter) {
    return unavailable("unsupported");
  }
  const doc = target.document;
  if (!doc) return unavailable("unsupported");
  const importModule = options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let modules: NativeChatVoiceGraph | undefined;
  const prepareBudget = createNativeChatPrepareBudget();
  let lastStartObservation: NativeChatVoiceStartObservation | undefined;
  let boundScope: ChatVoiceScope | undefined;
  let mounted:
    { node: unknown; render(binding: NativeChatVoiceBinding): void; dispose(): void } | undefined;
  let button: HTMLButtonElement | undefined;
  const overlayButtons = new Map<HTMLButtonElement, [string, string]>();
  let controller: AbortController | undefined;
  let starting = false;
  let selectDraft: (() => void) | undefined;
  let restoreHeadline: (() => void) | undefined;
  let renderFailed = false;
  const started = Date.now();
  const showHeadline = () => {
    restoreHeadline?.();
    restoreHeadline = undefined;
  };
  const removeButton = () => {
    button?.remove();
    button = undefined;
    for (const [control, [display, priority]] of overlayButtons)
      if (
        control.style.getPropertyValue("display") === "none" &&
        control.style.getPropertyPriority("display") === "important"
      )
        control.style.setProperty("display", display, priority);
    overlayButtons.clear();
  };
  const release = () => {
    showHeadline();
    selectDraft = undefined;
    controller?.abort();
    controller = undefined;
    removeButton();
    mounted?.dispose();
    mounted = undefined;
    boundScope = undefined;
  };
  const visibleComposer = (): Element | undefined => {
    const forms = [...doc.querySelectorAll("[data-chatgpt-composer]")].filter(
      (form) => form.getBoundingClientRect().width > 0 && !form.closest("[hidden], [inert]"),
    );
    return forms.length === 1 ? forms[0] : undefined;
  };
  const leftoverInstantConnectStarting = (): boolean => {
    if (!boundScope || !modules || typeof modules.initial.SPn !== "function") return false;
    try {
      const state = (
        modules.initial.SPn(boundScope) as {
          getState(): {
            isVoiceModeActive?: boolean;
            server?: { connectionState?: unknown };
          };
        }
      ).getState();
      return state.isVoiceModeActive === true && state.server?.connectionState !== "connected";
    } catch {
      return false;
    }
  };
  const endLeftoverInstantConnect = (): void => {
    starting = false;
    const end = doc.querySelector<HTMLElement>(
      'button[aria-label="End Voice"], button[aria-label="End voice"]',
    );
    end?.click();
  };
  const releaseChatLaunchOwnership = (): void => {
    rememberVoiceProductExperience({ productExperience: "" }, target);
  };
  const findBinding = () => {
    if (!modules || !nativeChatVoicePreferenceAllowsStart(target)) return;
    const form = visibleComposer();
    if (!form) return;
    return detectNativeChatVoiceBinding(form, {
      scopeDefinition: modules.shared.Qst as NativeChatVoiceModules["scopeDefinition"],
      ownerScopeDefinition: modules.initial.MOr as NativeChatVoiceModules["ownerScopeDefinition"],
      backendConversationId: modules.initial.B1n,
      composerScopeDefinition: modules.initial
        .CDr as NativeChatVoiceModules["composerScopeDefinition"],
    });
  };
  const handle: ChatVoiceHook = {
    get activeCall() {
      if (starting) return true;
      if (!boundScope || !modules || typeof modules.initial.SPn !== "function") return false;
      try {
        return (
          modules.initial.SPn(boundScope) as { getState(): { isVoiceModeActive: boolean } }
        ).getState().isVoiceModeActive;
      } catch {
        return false;
      }
    },
    status: "pending",
    async start() {
      if (disposed) return;
      rememberVoiceProductExperience({ productExperience: "chat" }, target);
      const current = findBinding();
      const graph = modules;
      if (!current || !graph || current.appNode !== mounted?.node)
        throw new Error("Select a ChatGPT conversation to start Chat voice");
      if (starting) {
        lastStartObservation = {
          acknowledged: false,
          connected: false,
          conversationMatched: false,
          productMatched: false,
          category: "duplicate",
        };
        return lastStartObservation;
      }
      starting = true;
      controller = new AbortController();
      const signal = controller.signal;
      let origin: unknown;
      try {
        if (graph.initial.Ycr != null) origin = current.scope.get(graph.initial.Ycr);
      } catch {
        chatVoiceDebug("native-chat-selection-failed");
      }
      selectDraft = undefined;
      chatVoiceDebug("native-chat-start", {
        hasConversationId: current.backendConversationId !== undefined,
      });
      let nativeStartTimedOut = false;
      try {
        lastStartObservation = await startNativeChatVoiceSession({
          binding: current,
          modules: graph,
          signal,
          starting: false,
        });
        nativeStartTimedOut = lastStartObservation.category === "timeout";
        if (disposed || signal.aborted) {
          lastStartObservation = {
            acknowledged: lastStartObservation.acknowledged,
            connected: false,
            conversationMatched: lastStartObservation.conversationMatched,
            productMatched: lastStartObservation.productMatched,
            category: "cancelled",
          };
          throw new Error("Native Chat voice could not start");
        }
        if (
          lastStartObservation.category === "native-error" ||
          lastStartObservation.category === "cancelled" ||
          lastStartObservation.category === "timeout"
        ) {
          throw new Error("Native Chat voice could not start");
        }
        if (lastStartObservation.category === "start-acknowledged") {
          const category = await observeNativeChatVoiceConnection({
            read: () => readNativeChatVoiceObservedState(current.scope, graph.initial, current),
            signal,
          });
          if (disposed) {
            lastStartObservation = {
              acknowledged: true,
              connected: false,
              conversationMatched: false,
              productMatched: false,
              category: "cancelled",
            };
            throw new Error("Native Chat voice could not start");
          }
          const state = readNativeChatVoiceObservedState(current.scope, graph.initial, current);
          lastStartObservation = {
            acknowledged: true,
            connected: category === "connected",
            conversationMatched: state?.conversationMatched === true,
            productMatched: state?.isWorkMode === false,
            category,
          };
          chatVoiceDebug("native-chat-start-observation", {
            acknowledged: true,
            connected: lastStartObservation.connected,
            conversationMatched: lastStartObservation.conversationMatched,
            productMatched: lastStartObservation.productMatched,
            category,
          });
        }
        try {
          selectDraft = nativeChatVoiceDraftSelection(
            current,
            graph.initial,
            graph.shared,
            origin,
            signal,
          );
          selectDraft();
        } catch {
          chatVoiceDebug("native-chat-selection-failed");
        }
        if (lastStartObservation.category !== "connected") {
          throw new Error("Native Chat voice could not start");
        }
        return lastStartObservation;
      } finally {
        if (!nativeStartTimedOut) starting = false;
      }
    },
    dispose() {
      disposed = true;
      starting = false;
      controller?.abort();
      if (timer !== undefined) target.clearTimeout(timer);
      release();
      if (target[HOOK_GLOBAL] === handle) Reflect.deleteProperty(target, HOOK_GLOBAL);
    },
  };
  target[HOOK_GLOBAL] = handle;
  const onWaveClick = (): void => {
    rememberVoiceProductExperience({ productExperience: "chat" }, target);
    const run = handle.start();
    void Promise.resolve(run).catch(() => {
      chatVoiceDebug("native-chat-start-failed", {
        hashed,
        pending: handle.status !== "active",
        acknowledged: lastStartObservation?.acknowledged === true,
        connected: lastStartObservation?.connected === true,
        category: lastStartObservation?.category ?? "native-error",
      });
      if (button) button.title = "Chat voice could not start. Try again.";
    });
  };
  const placeComposerWave = (composer: Element, disabled: boolean): void => {
    const visibleControl = (control: HTMLButtonElement) =>
      control.getBoundingClientRect().width > 0 && !control.closest("[hidden], [inert]");
    const sends = [...composer.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].filter(
      visibleControl,
    );
    const official = [
      ...composer.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Start new voice chat"], button[aria-label="Start voice chat"]',
      ),
    ];
    const send = sends.length === 1 ? sends[0] : undefined;
    // Empty ChatGPT home has no Send. Occupy the official voice slot, then hide it.
    const anchor = send ?? official.find(visibleControl) ?? official[0];
    if (!anchor?.parentElement) {
      removeButton();
      return;
    }
    if (!button || !composer.contains(button)) {
      removeButton();
      button = doc.createElement("button");
      button.type = "button";
      button.setAttribute(BUTTON, "");
      button.setAttribute("aria-label", "Start Voice");
      button.title = "Start Voice";
      button.innerHTML =
        '<svg class="icon-primary-action text-composer-primary" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 8v4m4-7v10m6-12v14m4-9v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      button.addEventListener("click", onWaveClick);
    }
    if (button.nextElementSibling !== anchor) anchor.parentElement.insertBefore(button, anchor);
    alignNativeChatVoiceButton(button, anchor, doc);
    rememberVoiceProductExperience({ productExperience: "chat" }, target);
    // The Codex entry opens onboarding/optimistic launch state before its
    // service RPC. Only the native Chat START control belongs in this composer.
    for (const control of official) {
      if (!overlayButtons.has(control))
        overlayButtons.set(control, [
          control.style.getPropertyValue("display"),
          control.style.getPropertyPriority("display"),
        ]);
      control.style.setProperty("display", "none", "important");
    }
    const styleSource =
      (send && !send.disabled ? send : undefined) ??
      official.find(visibleControl) ??
      official[0] ??
      send ??
      anchor;
    if (button && styleSource) {
      button.disabled = disabled;
      if (!disabled && button.title === "Chat voice is not ready") button.title = "Start Voice";
      // Empty Send is disabled independently of whether voice can start.
      const className = [
        ...String(styleSource.className ?? "")
          .split(/\s+/)
          .filter(
            (name) =>
              name !== "opacity-50" &&
              name !== "cursor-default" &&
              name !== "cursor-not-allowed" &&
              name !== "pointer-events-none",
          ),
        ...(button.disabled ? ["opacity-50", "cursor-default"] : []),
      ].join(" ");
      if (button.className !== className) button.className = className;
      const pointerEvents = button.disabled ? "none" : "auto";
      if (button.style.pointerEvents !== pointerEvents) button.style.pointerEvents = pointerEvents;
    }
  };
  const showHashedComposerWave = (): boolean => {
    if (!hashed || !nativeChatVoicePreferenceAllowsStart(target)) return false;
    const composer = visibleComposer();
    if (!composer) return false;
    mounted?.dispose();
    mounted = undefined;
    boundScope = undefined;
    placeComposerWave(composer, true);
    if (button) button.title = "Chat voice is not ready";
    handle.status = "pending";
    return true;
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    try {
      // The hashed graph is only safe to initialize after the Chat surface mounts.
      if (hashed && !visibleComposer()) {
        selectDraft?.();
        // Instant Connect hides the Chat composer while our START is in flight.
        if (starting) return;
        if (leftoverInstantConnectStarting()) {
          endLeftoverInstantConnect();
          releaseChatLaunchOwnership();
          release();
          handle.status = "pending";
          return;
        }
        if (handle.activeCall) return;
        releaseChatLaunchOwnership();
        release();
        handle.status = "pending";
        return;
      }
      if (renderFailed) throw new Error();
      if (!modules) {
        const names = loadedAssetNames(doc, target.performance);
        const graphKey = `${adapter}:${config.desktopVersion ?? ""}:${config.desktopPlatform ?? ""}`;
        if (hashed && !hashedNativeChatGraphReady(names)) {
          if (showHashedComposerWave()) return;
          if (Date.now() - started >= 60_000) handle.status = "unsupported";
          return;
        }
        if (!prepareBudget.allow(graphKey)) {
          if (showHashedComposerWave()) return;
          if (Date.now() - started >= 60_000) handle.status = "unsupported";
          return;
        }
        try {
          modules = await loadNativeChatVoiceGraph({
            adapter,
            names,
            config,
            importModule,
          });
        } catch {
          prepareBudget.fail(graphKey);
          throw new Error();
        }
        if (!modules) {
          if (Date.now() - started >= 60_000) {
            handle.status = "unsupported";
            return;
          }
          return;
        }
        prepareBudget.reset(graphKey);
        if (disposed) {
          modules = undefined;
          return;
        }
      }
      const current = findBinding();
      selectDraft?.();
      if (mounted && current && current.appNode !== mounted.node) {
        controller?.abort();
        starting = false;
        prepareBudget.reset();
        release();
      }
      if (starting) {
        if (current) boundScope = current.scope;
        return;
      }
      if (!current) {
        showHeadline();
        if (leftoverInstantConnectStarting()) {
          endLeftoverInstantConnect();
        } else if (handle.activeCall) return;
        releaseChatLaunchOwnership();
        if (showHashedComposerWave()) return;
        release();
        handle.status = "pending";
        return;
      }
      if (mounted && current.appNode !== mounted.node) {
        prepareBudget.reset();
        release();
      }
      boundScope = current.scope;
      if (!mounted) {
        mounted = mountNativeChatVoiceRuntime({
          adapter,
          binding: current,
          modules,
          document: doc,
          onRenderFailed() {
            renderFailed = true;
          },
        });
      }
      mounted.render(current);
      const observed = readNativeChatVoiceObservedState(current.scope, modules.initial, current);
      if (
        current.props.conversationId.startsWith("local-chatgpt:") &&
        observed?.voiceModeActive &&
        observed.isWorkMode === false &&
        observed.conversationMatched
      )
        restoreHeadline ??= hideNativeChatVoiceHomeHeadline(doc);
      else showHeadline();
      placeComposerWave(
        current.composer,
        starting || current.props.isStreaming === true || nativeChatVoiceSessionLive(observed),
      );
      handle.status = "active";
    } catch {
      chatVoiceDebug("native-chat-binding-failed", {
        category: "binding-failed",
      });
      if (showHashedComposerWave()) return;
      release();
      handle.status = "pending";
      return;
    } finally {
      if (!disposed && handle.status !== "unsupported")
        timer = target.setTimeout(() => void refresh(), 500);
    }
  };
  void refresh();
  return handle;
}
