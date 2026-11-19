import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashedGatewayStarterOptions,
  installHashedOverlayWorkCapability,
  wrapHashedOverlayRealtimeStarter,
} from "../src/renderer-hashed-gateway-start.js";
import { installOverlayVoiceBootstrap } from "../src/overlay-voice-bootstrap-entry.js";
import {
  hashedOverlayVoiceStarterFibers,
  wrapGatewayVoiceStarter,
} from "../src/renderer-voice-start-capability.js";
import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../src/renderer-cpa-live-voice-hook.js";
import { HASHED_WEBPACK_VOICE_VERSION } from "../src/renderer-hashed-native-chat-voice.js";
import {
  HASHED_26_1106_VOICE_EVALUATOR,
  HASHED_OVERLAY_VOICE_ROLES,
} from "../src/renderer-voice-profiles.js";
import { applySharedVoiceRoutes } from "../src/renderer-cpa-live-voice-preference.js";
import { attachReviewedVoiceEvidence, hashedVoiceTestIdentity } from "./voice-evidence-fixture.js";
import type { HashedWebpackRequire } from "../src/renderer-hashed-native-chat-voice.js";

afterEach(() => vi.useRealTimers());

const SURFACE_SELECTOR = "[data-avatar-overlay-native-surface-id]";

type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: unknown };

type TestFamily = {
  scope: { id: unknown };
  kind?: string;
  read?: unknown;
  resolve(): { atom: Atom };
};

type TestTarget = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  document: Document;
  location: { href: string };
  __codexhostClientOwnedVoiceV1?: { status: string };
  __codexhostVoiceCapabilityV1?: {
    status?: string;
    reason?: string;
    current?: () => boolean;
    dispose?: () => void;
  };
  __codexhostOverlayVoiceBootstrapV1?: { version?: string; dispose?: () => void };
  [key: string]: unknown;
};

type Surface = {
  surface: Record<string, unknown>;
  subscriber: {
    getSnapshot: () => unknown;
    subscribe(listener: () => void): () => void;
    createRender?: () => unknown;
  };
  instance: { getSnapshot: () => unknown };
  original: () => unknown;
};

/** One hashed Compact Voice starter subscription, optionally committed late. */
function overlaySurface(
  accessAtom: Atom,
  family: TestFamily,
  options: { commitDelayMs?: number; onCommit?: () => void } = {},
): Surface {
  const atom: Atom = {
    read: (get) => ({
      isLoading: false,
      isError: false,
      isCapable: (get(accessAtom) as { status: string }).status === "allowed",
    }),
  };
  const store: {
    get(atom: Atom): unknown;
    sub(atom: Atom, listener: () => void): () => void;
  } = {
    get: (dependency) => dependency.read(store.get),
    sub: () => () => {},
  };
  const signal = { atom, store };
  const original = (): unknown => store.get(atom);
  const subscriber = {
    getSnapshot: original,
    subscribe: (listener: () => void) => store.sub(atom, listener),
    createRender: () => undefined,
  };
  const instance = { getSnapshot: original };
  const subscription = {
    memoizedState: [subscriber, [signal, undefined]],
    next: {
      memoizedState: original(),
      queue: instance,
      next: {
        memoizedState: {
          create: () => subscriber.subscribe(notify),
          deps: [subscriber.subscribe],
        },
        next: null,
      },
    },
  };
  function commit(): void {
    subscription.next.memoizedState = subscriber.getSnapshot();
    options.onCommit?.();
  }
  function notify(): void {
    if (options.commitDelayMs === undefined) commit();
    else setTimeout(commit, options.commitDelayMs);
  }
  const key = JSON.stringify({ name: "voice.realtime" });
  const node = {
    store,
    familyBindings: new Map([[family, new Map([[key, { cacheKey: "owned" }]])]]),
  };
  const chain = new Map([[family.scope.id, node]]);
  const owner = {
    memoizedState: {
      memoizedState: [signal, ["owned", chain, undefined, family, undefined]],
      next: subscription,
    },
    return: null,
  };
  return { surface: { __reactFiber$overlay: owner }, subscriber, instance, original };
}

function overlayWorkFixture(
  options: {
    client?: "active" | "pending";
    surface?: boolean;
    preference?: "gateway" | "desktop";
    evidence?: readonly ("work-codex" | "work-grok")[];
    commitDelayMs?: number;
    onCommit?: () => void;
  } = {},
) {
  const accessAtom: Atom = {
    read: () => ({
      status: "denied",
      reason: HASHED_26_1106_VOICE_EVALUATOR.unsupportedAuthReason,
    }),
  };
  const family: TestFamily = {
    scope: { id: Symbol("capability") },
    kind: HASHED_26_1106_VOICE_EVALUATOR.capabilityFamilyKind,
    read: () => undefined,
    resolve: () => ({ atom: { read: () => true, write: true } }),
  };
  const gates = {
    scope: { id: Symbol("inference-gate") },
    kind: HASHED_26_1106_VOICE_EVALUATOR.inferenceGateFamilyKind,
    resolve: () => ({ atom: { read: () => true, write: true } }),
  };
  const access = {
    scope: { id: Symbol("voice-access") },
    cache: "derived-access",
    createSubscriberAtom: () => ({}),
    resolve: () => accessAtom,
  };
  const services = {
    realtimeVoiceRuntime: {
      registerRealtimeStarter: vi.fn(),
      unregisterRealtimeStarter: vi.fn(),
    },
  };
  const req = Object.assign(
    (id: string) => {
      if (id === "GaA7") return { appServices: services };
      if (id === HASHED_OVERLAY_VOICE_ROLES.capabilityModuleId)
        return { [HASHED_OVERLAY_VOICE_ROLES.capabilityExport]: family };
      if (id === HASHED_OVERLAY_VOICE_ROLES.inferenceGateModuleId)
        return { [HASHED_OVERLAY_VOICE_ROLES.inferenceGateExport]: gates };
      if (id === HASHED_OVERLAY_VOICE_ROLES.voiceAccessModuleId)
        return { [HASHED_OVERLAY_VOICE_ROLES.voiceAccessExport]: access };
      throw new Error(id);
    },
    { m: {}, c: {} },
  ) as HashedWebpackRequire;
  const built: Surface[] = [];
  if (options.surface !== false) built.push(overlaySurface(accessAtom, family, options));
  const document = {
    querySelectorAll: (selector: string) =>
      selector === SURFACE_SELECTOR ? built.map((entry) => entry.surface) : [],
  } as unknown as Document;
  const target: TestTarget = {
    setTimeout,
    clearTimeout,
    location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
    document,
    ...(options.client === "pending"
      ? {}
      : { __codexhostClientOwnedVoiceV1: { status: "active" } }),
    [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
      enabled: true,
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      desktopPlatform: "darwin",
      auditedDesktopVersion: "26.1007.30912",
      auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      ...hashedVoiceTestIdentity(),
    },
  };
  if (options.evidence)
    attachReviewedVoiceEvidence(target[CPA_LIVE_VOICE_HOOK_GLOBAL] as Record<string, unknown>, [
      ...options.evidence,
    ]);
  applySharedVoiceRoutes(target, {
    chatExperience: "chatgpt",
    chatConnection: "desktop",
    workConnection: options.preference ?? "gateway",
  });
  return { target, req, accessAtom, family, built, services };
}

const workRequest = (model?: string) => ({
  source: "composer_button_new_thread",
  productExperience: "work",
  hostId: "local",
  ...(model === undefined ? {} : { activeCollaborationMode: { settings: { model } } }),
});

describe("hashed overlay realtime starter", () => {
  it("registers Compact Voice through wrapGatewayVoiceStarter", async () => {
    const fixture = overlayWorkFixture({ evidence: ["work-codex"] });
    const restoreCapability = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({
      status: "active",
      reason: "access-replay",
    });
    const nativeStart = vi.fn(async () => "existingCall");
    const nativeCancel = vi.fn();
    const register = vi.fn();
    const unregister = vi.fn();
    const runtime = { registerRealtimeStarter: register, unregisterRealtimeStarter: unregister };
    const services = { realtimeVoiceRuntime: runtime };
    const restore = wrapHashedOverlayRealtimeStarter(services, fixture.target);
    expect(restore).toEqual(expect.any(Function));
    expect(services.realtimeVoiceRuntime).not.toBe(runtime);
    services.realtimeVoiceRuntime.registerRealtimeStarter(nativeStart, nativeCancel);
    expect(register).toHaveBeenCalledOnce();
    const wrappedStart = register.mock.calls[0]?.[0] as (request: unknown) => Promise<unknown>;
    const result = await wrappedStart(workRequest());
    expect(nativeStart).toHaveBeenCalledOnce();
    expect(result).toBe("existingCall");
    restore?.();
    expect(services.realtimeVoiceRuntime).toBe(runtime);
    restoreCapability?.();
  });

  it("collects hashed Compact Voice fibers without a named overlay page export", () => {
    const owner = { memoizedState: null, return: null };
    const surface = { __reactFiber$test: owner };
    const document = {
      querySelectorAll: (selector: string) => (selector === SURFACE_SELECTOR ? [surface] : []),
    } as unknown as Document;
    expect([...hashedOverlayVoiceStarterFibers(document)]).toEqual([owner]);
  });

  it("projects hashed Work Instant Connect on Compact Voice overlay fibers", () => {
    const fixture = overlayWorkFixture({ evidence: ["work-codex"] });
    const first = fixture.built[0] as Surface;
    const restore = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    expect(restore).toEqual(expect.any(Function));
    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({
      status: "active",
      reason: "access-replay",
    });
    expect(first.instance.getSnapshot()).toMatchObject({ isCapable: true });
    expect(fixture.target.__codexhostVoiceCapabilityV1?.current?.()).toBe(true);
    restore?.();
    expect(first.instance.getSnapshot).toBe(first.original);
    expect(fixture.target.__codexhostVoiceCapabilityV1).toBeUndefined();
  });

  it("does not project hashed Work capability onto the main Composer document", () => {
    const req = Object.assign(
      (id: string) => {
        throw new Error(id);
      },
      { m: {}, c: {} },
    ) as HashedWebpackRequire;
    const target: TestTarget = {
      setTimeout,
      clearTimeout,
      location: { href: "app://-/index.html" },
      document: { querySelectorAll: () => [] } as unknown as Document,
      __codexhostClientOwnedVoiceV1: { status: "active" },
    };
    expect(installHashedOverlayWorkCapability(target, req)).toBeUndefined();
    expect(target.__codexhostVoiceCapabilityV1).toBeUndefined();
  });

  it("retries the owned capability until the client hook and overlay fibers appear", async () => {
    vi.useFakeTimers();
    const fixture = overlayWorkFixture({
      client: "pending",
      surface: false,
      evidence: ["work-codex"],
    });
    const restore = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    expect(restore).toEqual(expect.any(Function));
    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({ status: "pending" });
    expect(fixture.target.__codexhostVoiceCapabilityV1?.current?.()).toBe(false);

    fixture.target.__codexhostClientOwnedVoiceV1 = { status: "active" };
    fixture.built.push(overlaySurface(fixture.accessAtom, fixture.family));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({
      status: "active",
      reason: "access-replay",
    });
    expect(fixture.target.__codexhostVoiceCapabilityV1?.current?.()).toBe(true);
    restore?.();
    expect(fixture.target.__codexhostVoiceCapabilityV1).toBeUndefined();
  });

  it("rebinds the owned capability after the overlay surface is replaced", async () => {
    vi.useFakeTimers();
    const fixture = overlayWorkFixture({ evidence: ["work-codex"] });
    const previous = fixture.built[0] as Surface;
    const restore = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    expect(fixture.target.__codexhostVoiceCapabilityV1?.current?.()).toBe(true);

    const replacement = overlaySurface(fixture.accessAtom, fixture.family);
    fixture.built.splice(0, fixture.built.length, replacement);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({ status: "active" });
    expect(fixture.target.__codexhostVoiceCapabilityV1?.current?.()).toBe(true);
    expect(replacement.subscriber.getSnapshot).not.toBe(replacement.original);
    expect(previous.subscriber.getSnapshot).toBe(previous.original);
    restore?.();
  });

  it("waits for the committed capability snapshot before native start", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const fixture = overlayWorkFixture({
      evidence: ["work-codex"],
      commitDelayMs: 20,
      onCommit: () => events.push("commit"),
    });
    const restore = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({ status: "active" });
    expect(fixture.target.__codexhostVoiceCapabilityV1?.current?.()).toBe(false);

    const nativeStart = vi.fn(async () => {
      events.push("start");
      return "existingCall";
    });
    const register = vi.fn();
    const services = {
      realtimeVoiceRuntime: {
        registerRealtimeStarter: register,
        unregisterRealtimeStarter: vi.fn(),
      },
    };
    wrapHashedOverlayRealtimeStarter(services, fixture.target);
    services.realtimeVoiceRuntime.registerRealtimeStarter(nativeStart, vi.fn());
    const wrappedStart = register.mock.calls[0]?.[0] as (request: unknown) => Promise<unknown>;

    const started = wrappedStart(workRequest());
    await vi.advanceTimersByTimeAsync(60);
    await started;

    expect(nativeStart).toHaveBeenCalledOnce();
    expect(events).toEqual(["commit", "start"]);
    restore?.();
  });

  it("waits for capability installation when Work is selected immediately before Start", async () => {
    vi.useFakeTimers();
    const fixture = overlayWorkFixture({ evidence: ["work-codex"] });
    const nativeStart = vi.fn(async () => "existingCall");
    const wrapper = wrapGatewayVoiceStarter(
      nativeStart,
      hashedGatewayStarterOptions(fixture.target),
    );
    const started = wrapper.start(workRequest());
    await vi.advanceTimersByTimeAsync(100);
    expect(nativeStart).not.toHaveBeenCalled();
    const restore = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    await vi.advanceTimersByTimeAsync(50);
    await expect(started).resolves.toBe("existingCall");
    expect(nativeStart).toHaveBeenCalledOnce();
    restore?.();
  });

  it("gates external overlay requests even without a primary composer owner", async () => {
    const fixture = overlayWorkFixture({ evidence: ["work-codex"] });
    const nativeStart = vi.fn(async () => "existingCall");
    const register = vi.fn();
    const services = { realtimeVoiceRuntime: { registerRealtimeStarter: register } };
    const dispose = wrapHashedOverlayRealtimeStarter(services, fixture.target);
    services.realtimeVoiceRuntime.registerRealtimeStarter(nativeStart, vi.fn());
    const start = register.mock.calls[0]?.[0] as (request: unknown) => Promise<unknown>;
    await expect(start(workRequest("codexhost/grok-4"))).rejects.toThrow(/not qualified/);
    expect(nativeStart).not.toHaveBeenCalled();
    dispose?.();
  });

  it("does not start an external Harness request without lane evidence", async () => {
    const fixture = overlayWorkFixture({ evidence: [] });
    const restore = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    const nativeStart = vi.fn(async () => "existingCall");
    const options = hashedGatewayStarterOptions(
      fixture.target,
      () => true,
      () => false,
      () => true,
    );
    const wrapper = wrapGatewayVoiceStarter(nativeStart, options);
    const request = workRequest("codexhost/grok-4");

    expect(options.configured(request)).toBe(true);
    expect(options.qualifies(request)).toBe(false);
    await expect(wrapper.start(request)).rejects.toThrow(/not qualified/);
    expect(nativeStart).not.toHaveBeenCalled();
    restore?.();
  });

  it("keeps qualified external voice on gateway when Work chooses Desktop", async () => {
    const fixture = overlayWorkFixture({ evidence: ["work-grok"] });
    applySharedVoiceRoutes(fixture.target, {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "desktop",
    });
    const dispose = installHashedOverlayWorkCapability(fixture.target, fixture.req);
    const options = hashedGatewayStarterOptions(fixture.target);
    expect(options.configured(workRequest("codexhost/grok-4"))).toBe(true);
    expect(options.qualifies(workRequest("codexhost/grok-4"))).toBe(true);
    expect(await options.ready()).toBe(true);
    const binding = await options.prepare();
    expect(binding.current()).toBe(true);
    expect(options.configured(workRequest())).toBe(false);
    dispose?.();
  });

  it("requires the reviewed lane selected by the request", () => {
    const fixture = overlayWorkFixture({ evidence: ["work-grok"] });
    const options = hashedGatewayStarterOptions(
      fixture.target,
      () => true,
      () => false,
      () => false,
    );
    expect(options.qualifies(workRequest("codexhost/grok-4"))).toBe(true);
    expect(options.qualifies(workRequest())).toBe(false);
  });
});

describe("hashed overlay voice bootstrap", () => {
  it("replaces the previous bootstrap without stacking proxies or bindings", async () => {
    vi.useFakeTimers();
    const fixture = overlayWorkFixture({ client: "pending", evidence: ["work-codex"] });
    const originalRuntime = fixture.services.realtimeVoiceRuntime;
    const importRuntime = async () => ({ __webpack_require__: fixture.req });

    const first = installOverlayVoiceBootstrap(fixture.target, { importRuntime });
    expect(first).toBeDefined();
    expect(first?.version).toEqual(expect.any(String));
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.services.realtimeVoiceRuntime).not.toBe(originalRuntime);
    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({ status: "pending" });

    const firstCapability = fixture.target.__codexhostVoiceCapabilityV1;
    // The bootstrap installs the pending client hook; activation is the native
    // wrapper finding the webpack client, not a replacement handle.
    const client = fixture.target.__codexhostClientOwnedVoiceV1;
    if (!client) throw new Error("bootstrap client hook unavailable");
    client.status = "active";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.target.__codexhostVoiceCapabilityV1).toMatchObject({ status: "active" });

    const second = installOverlayVoiceBootstrap(fixture.target, { importRuntime });
    expect(second).not.toBe(first);
    expect(fixture.services.realtimeVoiceRuntime).toBe(originalRuntime);
    expect(fixture.target.__codexhostVoiceCapabilityV1).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.services.realtimeVoiceRuntime).not.toBe(originalRuntime);
    expect(fixture.target.__codexhostVoiceCapabilityV1).not.toBe(firstCapability);

    second?.dispose();
    expect(fixture.services.realtimeVoiceRuntime).toBe(originalRuntime);
    expect(fixture.target.__codexhostVoiceCapabilityV1).toBeUndefined();
    expect(fixture.target.__codexhostOverlayVoiceBootstrapV1).toBeUndefined();
    expect(fixture.built[0]?.subscriber.getSnapshot).toBe(fixture.built[0]?.original);
  });
});
