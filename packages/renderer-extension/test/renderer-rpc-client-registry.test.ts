import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ root: null as unknown, candidates: [] as unknown[] }));
vi.mock("@codexhost/desktop-control/renderer-bindings", () => ({
  findRendererAppScopeStore: () => f.root,
}));
vi.mock("../src/codex-native-services.js", () => ({
  loadCodexNativeServices: async (_owner: unknown, matches: (v: unknown) => boolean) => {
    const found = new Set(f.candidates.filter(matches));
    if (found.size > 1) throw new Error("Ambiguous registry");
    return [...found][0] ?? null;
  },
}));
import { rendererRpcClientRegistryReader } from "../src/renderer-rpc-client-registry.js";

beforeEach(() => {
  f.root = null;
  f.candidates = [];
});
function fixture() {
  const registry = {
    forHost: () => ({}),
    collectAppStateSnapshot() {},
    getReviewPaneSnapshotMetrics() {},
    dispose() {},
  };
  const definition = { cache: "signal" };
  const unbound = { cache: "signal" };
  const atom = {};
  const get = vi.fn((atom: unknown): unknown => {
    void atom;
    return registry;
  });
  f.root = { signalBindings: new WeakMap([[definition, atom]]), store: { get } };
  f.candidates = [unbound, definition, definition, null, () => undefined];
  const ready = vi.fn();
  const reader = rendererRpcClientRegistryReader({ document: {} } as Window, ready);
  return { registry, definition, unbound, atom, get, reader, ready };
}
it("discovers a unique registry from already-bound signal definitions without initializing others", async () => {
  const x = fixture();
  expect(x.reader.read()).toBeNull();
  await vi.waitFor(() => expect(x.ready).toHaveBeenCalledOnce());
  expect(x.reader.read()).toBe(x.registry);
  expect(x.get.mock.calls.every((call) => call[0] === x.atom)).toBe(true);
  x.reader.dispose();
  expect(x.reader.read()).toBeNull();
});
it("reads a replaced native registry from the bound atom and rejects ambiguous definitions", async () => {
  const x = fixture();
  x.reader.read();
  await vi.waitFor(() => expect(x.ready).toHaveBeenCalledOnce());
  const next = { ...x.registry };
  x.get.mockReturnValue(next);
  expect(x.reader.read()).toBe(next);
  x.reader.dispose();
  const y = fixture();
  const second = { cache: "signal" };
  (f.root as { signalBindings: WeakMap<object, unknown> }).signalBindings.set(second, {});
  f.candidates.push(second);
  y.reader.read();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(y.ready).not.toHaveBeenCalled();
  expect(y.reader.read()).toBeNull();
  y.reader.dispose();
});
