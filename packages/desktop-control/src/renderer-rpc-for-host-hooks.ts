type ForHost = (hostId: string) => unknown;
interface Registry {
  forHost: ForHost;
}
interface Link {
  owner: Registry;
  previous: ForHost;
}
const links = new WeakMap<ForHost, Link>();

/** Only traverse hooks installed by this bundle; an unrelated replacement retires ownership. */
export function rendererRpcForHostOwns(owner: Registry, method: unknown): boolean {
  const seen = new Set<ForHost>();
  let current = owner.forHost;
  while (typeof current === "function" && !seen.has(current)) {
    if (current === method) return true;
    seen.add(current);
    const link = links.get(current);
    if (link?.owner !== owner) return false;
    current = link.previous;
  }
  return false;
}

/** Submission preparation and steering share the native registry. Keep their predecessor
 * links explicit so refresh recognizes both hooks and either can be removed independently. */
export function installRendererRpcForHostHook(
  owner: Registry,
  create: (upstream: ForHost) => ForHost,
) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, "forHost");
  if (!descriptor?.writable || typeof descriptor.value !== "function") return null;
  const link: Link = { owner, previous: descriptor.value as ForHost };
  const upstream: ForHost = (hostId) => link.previous.call(owner, hostId);
  const wrapped = create(upstream);
  let released = false;
  const forHost: ForHost = (hostId) => (released ? upstream(hostId) : wrapped(hostId));
  links.set(forHost, link);
  Object.defineProperty(owner, "forHost", { ...descriptor, value: forHost });
  return {
    forHost,
    upstream,
    owns: () => !released && rendererRpcForHostOwns(owner, forHost),
    release() {
      if (released) return;
      released = true;
      if (owner.forHost === forHost) {
        Object.defineProperty(owner, "forHost", { ...descriptor, value: link.previous });
        return;
      }
      const seen = new Set<ForHost>();
      let current = owner.forHost;
      while (typeof current === "function" && !seen.has(current)) {
        seen.add(current);
        const outer = links.get(current);
        if (outer?.owner !== owner) return;
        if (outer.previous === forHost) {
          outer.previous = link.previous;
          return;
        }
        current = outer.previous;
      }
    },
  };
}
