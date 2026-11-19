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
type ModuleFactory = (
  this: unknown,
  module?: unknown,
  exports?: unknown,
  require?: unknown,
) => unknown;

const BOOTSTRAP_GLOBAL = "__codexhostOverlayVoiceBootstrapV1";
/** A reinjected bundle replaces this bootstrap instead of stacking wraps. */
const BOOTSTRAP_VERSION = "hashed-overlay-voice-bootstrap-v1";
/** Native module that publishes the services the overlay starter registers on. */
const NATIVE_SERVICES_MODULE = "GaA7";
const ATTACH_RETRY_MS = 250;

/** Read the published services without requiring the module: native startup owns
 * initialization, and an early require caches its missing factory. */
function publishedServices(req: HashedWebpackRequire): RecordValue | undefined {
  const moduleExports = req.c?.[NATIVE_SERVICES_MODULE]?.exports;
  if (moduleExports === null || typeof moduleExports !== "object") return;
  const services = Reflect.get(moduleExports as RecordValue, "appServices");
  return services !== null && typeof services === "object" ? (services as RecordValue) : undefined;
}

/** Native GaA7 publishes `appServices` through a module-local getter, and the
 * overlay registers its Compact Voice starter from that object. Observing the
 * getter wraps the runtime before the registration reads it, so a starter
 * registered between polls still waits for the gateway. The factory is captured
 * when the async chunk installs it; exports keep their native values because the
 * proxy only observes the read. */
function observeHashedAppServices(
  req: HashedWebpackRequire,
  attach: (services: RecordValue) => boolean,
): Disposer | undefined {
  const modules = req.m;
  const existing = modules
    ? Object.getOwnPropertyDescriptor(modules, NATIVE_SERVICES_MODULE)
    : undefined;
  if (!modules || (existing && !("value" in existing))) return;
  const proxies = new WeakMap<object, RecordValue>();
  const restores: Disposer[] = [];
  let observing = true;
  let factory =
    typeof existing?.value === "function" ? (existing.value as ModuleFactory) : undefined;
  let wrapped: ModuleFactory | undefined;

  const observed = (moduleExports: unknown): RecordValue | undefined => {
    if (moduleExports === null || typeof moduleExports !== "object") return;
    const known = proxies.get(moduleExports);
    if (known) return known;
    const proxy = new Proxy(moduleExports as RecordValue, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (observing && key === "appServices" && value !== null && typeof value === "object") {
          try {
            attach(value as RecordValue);
          } catch {
            /* Native startup keeps its own service read. */
          }
        }
        return value;
      },
    });
    proxies.set(moduleExports, proxy);
    return proxy;
  };

  if (
    !Reflect.defineProperty(modules, NATIVE_SERVICES_MODULE, {
      configurable: true,
      enumerable: existing?.enumerable ?? true,
      get: () => {
        if (!factory) return undefined;
        wrapped ??= function (this: unknown, module, exports, require) {
          const proxy = observed(exports);
          if (proxy && module !== null && typeof module === "object") {
            const cached = module as { exports?: unknown };
            if (Reflect.set(cached, "exports", proxy))
              restores.push(() => {
                if (cached.exports === proxy) Reflect.set(cached, "exports", exports);
              });
          }
          return Reflect.apply(factory as ModuleFactory, this, [module, proxy ?? exports, require]);
        };
        return wrapped;
      },
      set: (value: unknown) => {
        factory = typeof value === "function" ? (value as ModuleFactory) : undefined;
        wrapped = undefined;
      },
    })
  )
    return;
  restores.push(() => {
    const current = factory;
    if (current && current !== existing?.value)
      Reflect.defineProperty(modules, NATIVE_SERVICES_MODULE, {
        value: current,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    else if (existing) Reflect.defineProperty(modules, NATIVE_SERVICES_MODULE, existing);
    else Reflect.deleteProperty(modules, NATIVE_SERVICES_MODULE);
  });

  const cached = req.c?.[NATIVE_SERVICES_MODULE];
  if (cached && typeof cached === "object" && cached.exports != null) {
    const original = cached.exports;
    const proxy = observed(original);
    if (proxy && proxy !== original && Reflect.set(cached, "exports", proxy))
      restores.push(() => {
        if (cached.exports === proxy) Reflect.set(cached, "exports", original);
      });
  }
  return () => {
    observing = false;
    for (const restore of restores.reverse()) restore();
  };
}

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
    let retry: ReturnType<typeof setTimeout> | undefined;
    let capabilityTimer: ReturnType<typeof setTimeout> | undefined;
    disposers.push(() => {
      if (retry !== undefined) target.clearTimeout(retry);
      if (capabilityTimer !== undefined) target.clearTimeout(capabilityTimer);
    });
    let req: HashedWebpackRequire | undefined;
    let capabilityScheduled = false;
    const attached = new WeakSet<object>();

    // Capability lookup requires native modules, so it stays out of the native
    // service getter that triggers attachment.
    const scheduleCapability = () => {
      if (capabilityScheduled || disposed) return;
      capabilityScheduled = true;
      capabilityTimer = target.setTimeout(() => {
        if (disposed || !req) return;
        const disposeCapability = installHashedOverlayWorkCapability(target, req);
        if (disposeCapability) disposers.push(disposeCapability);
      }, 0);
    };

    const attachServices = (services: RecordValue): boolean => {
      if (disposed) return false;
      if (attached.has(services)) return true;
      const restore = wrapHashedOverlayRealtimeStarter(services, target);
      if (!restore) return false;
      attached.add(services);
      disposers.push(restore);
      scheduleCapability();
      return true;
    };

    const attach = async (): Promise<void> => {
      if (disposed) return;
      try {
        if (!req) {
          const runtime = await importRuntime(
            `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}`,
          );
          if (disposed) return;
          const resolved = runtime.__webpack_require__ as HashedWebpackRequire | undefined;
          if (typeof resolved === "function") {
            req = resolved;
            const disposeObservation = observeHashedAppServices(req, attachServices);
            if (disposeObservation) disposers.push(disposeObservation);
          }
        }
        const services = req ? publishedServices(req) : undefined;
        if (services && attachServices(services)) return;
      } catch {
        /* Native services can become available after the runtime import resolves. */
      }
      if (!disposed) retry = target.setTimeout(() => void attach(), ATTACH_RETRY_MS);
    };
    void attach();
  });
  return handle;
}

installOverlayVoiceBootstrap(globalThis);
