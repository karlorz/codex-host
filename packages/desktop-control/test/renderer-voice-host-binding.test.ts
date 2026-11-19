import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";

import {
  REALTIME_CALL_METHOD,
  VOICE_GATEWAY_STATUS_METHOD,
  VOICE_SETTINGS_METHOD,
  realtimeCallParamsSchema,
} from "@codexhost/shared-contracts";
import {
  isEligibleVoiceHostUrl,
  rendererVoiceHostDocumentGuardExpression,
} from "../src/renderer-app-url.js";
import {
  RENDERER_VOICE_HOST_BINDING_NAME,
  RENDERER_VOICE_HOST_CAPABILITY_GLOBAL,
  RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED,
  RENDERER_VOICE_HOST_DELIVER_GLOBAL,
  RENDERER_VOICE_HOST_PENDING_GLOBAL,
  RENDERER_VOICE_HOST_PUBLISH_RETRY_MS,
  installRendererVoiceHostBinding,
  rendererVoiceHostCapabilitySource,
  type RendererVoiceHostCdpClient,
  type RendererVoiceHostOwner,
} from "../src/renderer-voice-host-binding.js";

function fakeRenderer() {
  const listeners = new Map<string, (params: unknown) => void>();
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const events: string[] = [];
  const publishHolds: Array<() => void> = [];
  const pagePublishHolds: Array<() => void> = [];
  const deliverHolds: Array<() => void> = [];
  const evaluate = vi.fn(async <T>(expression: string): Promise<T> => {
    const publishing = expression.includes("Object.defineProperty(globalThis");
    events.push(publishing ? "evaluate:publish" : "evaluate:cleanup");
    if (publishing && renderer.holdNextPublish) {
      renderer.holdNextPublish = false;
      await new Promise<void>((resolve) => {
        publishHolds.push(resolve);
      });
    }
    return true as T;
  });
  let scripts = 0;
  const hrefByContext: Record<number, string> = { 1: "app://-/index.html" };
  const topByContext: Record<number, boolean> = {};
  const hrefHolds: Array<() => void> = [];
  const addHolds: Array<() => void> = [];
  const removeHolds: Array<() => void> = [];
  const renderer = {
    commands,
    events,
    evaluate,
    listeners,
    hrefByContext,
    topByContext,
    hrefHolds,
    addHolds,
    removeHolds,
    publishHolds,
    pagePublishHolds,
    deliverHolds,
    holdNextAdd: false,
    holdNextRemove: false,
    holdNextPagePublish: false,
    holdNextPublish: false,
    holdNextDeliver: false,
    failNextAdd: false,
    holdHref: false,
    command: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, ...(params ? { params } : {}) });
      events.push(`command:${method}`);
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        if (renderer.holdNextAdd) {
          renderer.holdNextAdd = false;
          await new Promise<void>((resolve) => {
            addHolds.push(resolve);
          });
        }
        if (renderer.failNextAdd) {
          renderer.failNextAdd = false;
          throw new Error("Page.addScriptToEvaluateOnNewDocument failed");
        }
        scripts += 1;
        return { identifier: `script-${scripts}` };
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        if (renderer.holdNextRemove) {
          renderer.holdNextRemove = false;
          await new Promise<void>((resolve) => {
            removeHolds.push(resolve);
          });
        }
        return {};
      }
      if (method === "Runtime.evaluate") {
        const expression = typeof params?.expression === "string" ? params.expression : "";
        if (expression.includes('"ok":true') && renderer.holdNextDeliver) {
          renderer.holdNextDeliver = false;
          await new Promise<void>((resolve) => {
            deliverHolds.push(resolve);
          });
        }
        if (
          expression.includes("href:String(location.href)") ||
          expression.includes("location.href")
        ) {
          if (renderer.holdHref) {
            await new Promise<void>((resolve) => {
              hrefHolds.push(resolve);
            });
          }
          const contextId = typeof params?.contextId === "number" ? params.contextId : 1;
          const href = hrefByContext[contextId] ?? "";
          const top = topByContext[contextId] ?? contextId !== 99;
          return { result: { value: { href, top } } };
        }
        return { result: { value: true } };
      }
      return {};
    }),
    on: vi.fn((method: string, listener: (params: unknown) => void) => {
      events.push(`on:${method}`);
      listeners.set(method, listener);
      return () => listeners.delete(method);
    }),
    emit(method: string, params: unknown) {
      listeners.get(method)?.(params);
    },
  };
  return renderer;
}

function host(overrides: Partial<RendererVoiceHostOwner> = {}): RendererVoiceHostOwner & {
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => ({ ok: true }));
  return {
    owner: "owner-1",
    generation: 1,
    request,
    ...overrides,
  } as RendererVoiceHostOwner & { request: ReturnType<typeof vi.fn> };
}

function payload(input: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    id: "req-1",
    owner: "owner-1",
    generation: 1,
    method: VOICE_SETTINGS_METHOD,
    params: { operation: "get" },
    ...input,
  });
}

function createPayload(input: Record<string, unknown> = {}) {
  return payload({
    id: "create-1",
    method: REALTIME_CALL_METHOD,
    params: {
      operation: "create",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      body: "{}",
    },
    ...input,
  });
}

function createdCallResult() {
  return {
    status: 201,
    body: "",
    headers: { location: "/realtime/calls/call-123" },
  };
}

function operations(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.map(([, value]) =>
    value && typeof value === "object" && "operation" in value
      ? (value as { operation?: unknown }).operation
      : undefined,
  );
}

function expectAbandonedCreate(request: ReturnType<typeof vi.fn>) {
  const seen = operations(request);
  expect(seen.filter((operation) => operation === "create")).toEqual(["create"]);
  expect(seen.filter((operation) => operation === "cancel")).toHaveLength(1);
  expect(seen.filter((operation) => operation === "hangup")).toHaveLength(1);
}

function evaluateExpression(item: { method: string; params?: Record<string, unknown> }): string {
  return item.method === "Runtime.evaluate" && typeof item.params?.expression === "string"
    ? item.params.expression
    : "";
}

function emitDefaultContext(
  renderer: ReturnType<typeof fakeRenderer>,
  id = 1,
  uniqueId = `ctx-${id}`,
  isDefault = true,
) {
  renderer.emit("Runtime.executionContextCreated", {
    context: { id, uniqueId, auxData: { isDefault } },
  });
}

async function bindReady(renderer: ReturnType<typeof fakeRenderer>, owner = host()) {
  const dispose = await installRendererVoiceHostBinding(
    renderer as unknown as RendererVoiceHostCdpClient,
    owner,
  );
  emitDefaultContext(renderer);
  return { owner, dispose };
}

interface PageCapability {
  generation: number;
  instance: string;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** A Renderer page that really executes `evaluate`, so page-side capability and
 * pending-waiter state stays observable across binding installations. */
function pageSandbox(): Record<string, unknown> {
  const window = { top: null as unknown };
  window.top = window;
  let ids = 0;
  const bindingCalls: Array<Record<string, unknown>> = [];
  const sandbox: Record<string, unknown> = {
    window,
    location: { href: "app://-/index.html" },
    URL,
    Map,
    Object,
    JSON,
    Error,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => `id-${(ids += 1)}` },
    bindingCalls,
  };
  sandbox[RENDERER_VOICE_HOST_BINDING_NAME] = (raw: string) => {
    bindingCalls.push(JSON.parse(raw) as Record<string, unknown>);
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function pageRenderer(sandbox: Record<string, unknown>): ReturnType<typeof fakeRenderer> {
  const renderer = fakeRenderer();
  renderer.evaluate.mockImplementation(async <T>(expression: string): Promise<T> => {
    if (renderer.holdNextPagePublish && expression.includes("Object.defineProperty(globalThis")) {
      renderer.holdNextPagePublish = false;
      await new Promise<void>((resolve) => {
        renderer.pagePublishHolds.push(resolve);
      });
    }
    return vm.runInNewContext(expression, sandbox) as T;
  });
  return renderer;
}

function pageCapability(sandbox: Record<string, unknown>): PageCapability | undefined {
  return sandbox[RENDERER_VOICE_HOST_CAPABILITY_GLOBAL] as PageCapability | undefined;
}

function pageBindingCalls(sandbox: Record<string, unknown>): Array<Record<string, unknown>> {
  return sandbox.bindingCalls as Array<Record<string, unknown>>;
}

function publishExpressions(renderer: ReturnType<typeof fakeRenderer>): string[] {
  return renderer.evaluate.mock.calls
    .map(([expression]) => String(expression))
    .filter((expression) => expression.includes("Object.defineProperty(globalThis"));
}

describe("Renderer voice Host document eligibility", () => {
  it("matches primary and overlay app routes and rejects foreign hosts and paths", () => {
    const cases: Array<[string, boolean]> = [
      ["app://-/index.html", true],
      ["app://-/index.html?initialRoute=/avatar-overlay", true],
      ["app://-/index.html?initialRoute=%2Favatar-overlay", true],
      ["app://-/avatar-overlay.html", true],
      ["app://-/index.html?initialRoute=/local/thread", false],
      ["app://-/index.html?window=second", false],
      ["app://-/detached-window.html", false],
      ["app://chatgpt/index.html", false],
      ["https://chatgpt.com/", false],
    ];
    for (const [href, allowed] of cases) {
      const window = { top: null as unknown };
      window.top = window;
      const sandbox = { window, location: { href }, URL };
      expect(isEligibleVoiceHostUrl(href), href).toBe(allowed);
      expect(vm.runInNewContext(rendererVoiceHostDocumentGuardExpression(), sandbox), href).toBe(
        allowed,
      );
    }
  });

  it("does not install the capability on foreign new documents", () => {
    const window = { top: null as unknown };
    window.top = window;
    const sandbox: Record<string, unknown> = {
      window,
      location: { href: "app://-/detached-window.html" },
      URL,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(rendererVoiceHostCapabilitySource("owner-1", 1), sandbox);
    expect(sandbox[RENDERER_VOICE_HOST_CAPABILITY_GLOBAL]).toBeUndefined();
  });

  it("rejects subframes even on an eligible URL", () => {
    const window = { top: {} };
    const sandbox = {
      window,
      location: { href: "app://-/index.html" },
      URL,
    };
    expect(vm.runInNewContext(rendererVoiceHostDocumentGuardExpression(), sandbox)).toBe(false);
  });
});

describe("Renderer voice Host CDP binding", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("binds only the existing voice methods and keeps tokens out of the page source", () => {
    const source = rendererVoiceHostCapabilitySource("owner-1", 1);
    expect(source).toContain(VOICE_SETTINGS_METHOD);
    expect(source).toContain(VOICE_GATEWAY_STATUS_METHOD);
    expect(source).toContain(REALTIME_CALL_METHOD);
    expect(source).toContain("initialRoute");
    expect(source).toContain(RENDERER_VOICE_HOST_PENDING_GLOBAL);
    expect(source).toContain("setTimeout");
    expect(source).not.toContain("Bearer");
    expect(source).not.toContain("/v1/rpc");
    expect(source).not.toContain("127.0.0.1");
    expect(source).not.toContain("codexhost/harness/plugins/list");
    expect(source).toContain("return true;");
  });

  it("does not forward harness plugin list through the voice Host binding", async () => {
    const renderer = fakeRenderer();
    const { owner, dispose } = await bindReady(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({
        id: "plugins-1",
        method: "codexhost/harness/plugins/list",
        params: {},
      }),
    });
    await vi.waitFor(() => {
      const expressions = renderer.commands.map(evaluateExpression).join("\n");
      expect(expressions).toContain('"ok":false');
      expect(expressions).toContain("Local Host connection is unavailable");
    });
    expect(owner.request).not.toHaveBeenCalled();
    dispose();
  });

  it("loads settings and gateway status from the Host owner", async () => {
    const renderer = fakeRenderer();
    const { owner, dispose } = await bindReady(renderer);
    owner.request.mockImplementation(async (method: string) =>
      method === VOICE_GATEWAY_STATUS_METHOD ? true : { initialized: true },
    );
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload(),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    expect(owner.request).toHaveBeenCalledWith(VOICE_SETTINGS_METHOD, { operation: "get" });
    await vi.waitFor(() => {
      const expressions = renderer.commands.map(evaluateExpression).join("\n");
      expect(expressions).toContain('"ok":true');
      expect(expressions).toContain("initialized");
    });
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ id: "req-2", method: VOICE_GATEWAY_STATUS_METHOD, params: {} }),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledTimes(2));
    dispose();
    expect(renderer.commands.some((item) => item.method === "Runtime.removeBinding")).toBe(true);
  });

  it("creates, cancels, and hangs up overlay calls through the same Host owner", async () => {
    const renderer = fakeRenderer();
    renderer.hrefByContext[1] = "app://-/index.html?initialRoute=/avatar-overlay";
    const { owner, dispose } = await bindReady(renderer);
    for (const params of [
      { operation: "create", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", body: "{}" },
      { operation: "cancel", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { operation: "hangup", callId: "call-123" },
    ]) {
      renderer.emit("Runtime.bindingCalled", {
        name: RENDERER_VOICE_HOST_BINDING_NAME,
        executionContextId: 1,
        payload: payload({ id: params.operation, method: REALTIME_CALL_METHOD, params }),
      });
    }
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledTimes(3));
    expect(owner.request.mock.calls.map(([method, value]) => [method, value.operation])).toEqual([
      [REALTIME_CALL_METHOD, "create"],
      [REALTIME_CALL_METHOD, "cancel"],
      [REALTIME_CALL_METHOD, "hangup"],
    ]);
    dispose();
  });

  it("rejects foreign app documents, isolated worlds, unsupported methods, stale generations, and oversized payloads", async () => {
    const renderer = fakeRenderer();
    const { owner, dispose } = await bindReady(renderer);
    renderer.hrefByContext[8] = "app://chatgpt/index.html";
    emitDefaultContext(renderer, 8, "foreign-app", true);
    emitDefaultContext(renderer, 7, "isolated", false);
    renderer.hrefByContext[7] = "app://-/index.html";
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 8,
      payload: payload({ id: "foreign-host" }),
    });
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 7,
      payload: payload({ id: "isolated" }),
    });
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 99,
      payload: payload({ id: "stale-context" }),
    });
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ id: "method", method: "thread/list" }),
    });
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ id: "stale", generation: 2 }),
    });
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: "x".repeat(256 * 1024 + 1),
    });
    await vi.waitFor(() => {
      const expressions = renderer.commands.map(evaluateExpression).join("\n");
      expect(expressions).toContain('"ok":false');
      expect(expressions.match(/"ok":false/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });
    renderer.topByContext[5] = false;
    renderer.hrefByContext[5] = "app://-/index.html";
    emitDefaultContext(renderer, 5, "subframe", true);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 5,
      payload: payload({ id: "subframe" }),
    });
    await vi.waitFor(() => {
      const expressions = renderer.commands.map(evaluateExpression).join("\n");
      expect(expressions).toContain("subframe");
    });
    expect(owner.request).not.toHaveBeenCalled();
    const serialized = JSON.stringify(renderer.command.mock.calls);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("token");
    dispose();
  });

  it("forgets destroyed and cleared execution contexts", async () => {
    const renderer = fakeRenderer();
    const { owner, dispose } = await bindReady(renderer);
    renderer.emit("Runtime.executionContextDestroyed", { executionContextId: 1 });
    delete renderer.hrefByContext[1];
    renderer.topByContext[1] = false;
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ id: "destroyed" }),
    });
    emitDefaultContext(renderer, 2, "later");
    renderer.hrefByContext[2] = "app://-/index.html";
    renderer.emit("Runtime.executionContextsCleared", {});
    delete renderer.hrefByContext[2];
    renderer.topByContext[2] = false;
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 2,
      payload: payload({ id: "cleared" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(owner.request).not.toHaveBeenCalled();
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain('"ok":true');
    dispose();
  });

  it("replaces the future document script on generation change and does not retry stale Host calls", async () => {
    const renderer = fakeRenderer();
    const listeners: Array<() => void> = [];
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => 1, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    Object.defineProperty(owner, "generation", { get: () => 2 });
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(renderer.evaluate).toHaveBeenCalledTimes(2));
    const scripts = renderer.commands.filter(
      (item) => item.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(scripts).toHaveLength(2);
    expect(String(scripts[1]?.params?.source)).toContain("const generation = 2");
    expect(
      renderer.commands.some((item) => item.method === "Page.removeScriptToEvaluateOnNewDocument"),
    ).toBe(true);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ generation: 1 }),
    });
    await vi.waitFor(() =>
      expect(
        renderer.command.mock.calls.some(
          ([method, params]) =>
            method === "Runtime.evaluate" && JSON.stringify(params).includes("unavailable"),
        ),
      ).toBe(true),
    );
    expect(owner.request).not.toHaveBeenCalled();
    const navigated = {
      window: { top: null as unknown },
      location: { href: "app://-/index.html" },
      URL,
    };
    navigated.window.top = navigated.window;
    const sandbox: Record<string, unknown> = {
      ...navigated,
      Map,
      Object,
      JSON,
      Error,
      setTimeout,
      clearTimeout,
      crypto: { randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(String(scripts[1]?.params?.source), sandbox);
    expect(
      (sandbox[RENDERER_VOICE_HOST_CAPABILITY_GLOBAL] as { generation: number }).generation,
    ).toBe(2);
    dispose();
    expect(JSON.stringify(renderer.evaluate.mock.calls)).toContain(
      RENDERER_VOICE_HOST_CAPABILITY_GLOBAL,
    );
  });

  it("does not deliver a bound inflight result after generation refresh", async () => {
    const renderer = fakeRenderer();
    let release: (value: unknown) => void = () => undefined;
    const pendingHost = new Promise((resolve) => {
      release = resolve;
    });
    const listeners: Array<() => void> = [];
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    let generation = 1;
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    owner.request.mockImplementation(async () => {
      await pendingHost;
      return { initialized: true };
    });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload(),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    generation = 2;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(renderer.evaluate).toHaveBeenCalledTimes(2));
    release(undefined);
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes('"ok":true')),
    ).toHaveLength(0);
    dispose();
  });

  it("settles current pending waiters across generation refresh in the page source", () => {
    const window = { top: null as unknown };
    window.top = window;
    const sandbox: Record<string, unknown> = {
      window,
      location: { href: "app://-/index.html" },
      URL,
      Map,
      Object,
      JSON,
      Error,
      setTimeout,
      clearTimeout,
      crypto: { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    };
    sandbox.globalThis = sandbox;
    let bindingCalls = 0;
    sandbox[RENDERER_VOICE_HOST_BINDING_NAME] = () => {
      bindingCalls += 1;
    };
    vm.runInNewContext(rendererVoiceHostCapabilitySource("owner-1", 1), sandbox);
    const cap = sandbox[RENDERER_VOICE_HOST_CAPABILITY_GLOBAL] as {
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    const pending = cap.request(VOICE_SETTINGS_METHOD, { operation: "get" });
    expect(bindingCalls).toBe(1);
    vm.runInNewContext(rendererVoiceHostCapabilitySource("owner-1", 2), sandbox);
    return expect(pending).rejects.toThrow("Local Host connection is unavailable");
  });

  it("rejects page pending waiters after the method timeout", async () => {
    vi.useFakeTimers();
    const window = { top: null as unknown };
    window.top = window;
    const sandbox: Record<string, unknown> = {
      window,
      location: { href: "app://-/index.html" },
      URL,
      Map,
      Object,
      JSON,
      Error,
      setTimeout,
      clearTimeout,
      crypto: { randomUUID: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    };
    sandbox.globalThis = sandbox;
    const payloads: Array<Record<string, unknown>> = [];
    sandbox[RENDERER_VOICE_HOST_BINDING_NAME] = (raw: string) => {
      payloads.push(JSON.parse(raw) as Record<string, unknown>);
    };
    vm.runInNewContext(rendererVoiceHostCapabilitySource("owner-1", 1), sandbox);
    const cap = sandbox[RENDERER_VOICE_HOST_CAPABILITY_GLOBAL] as {
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    const pending = cap.request(VOICE_GATEWAY_STATUS_METHOD, {});
    const settled = expect(pending).rejects.toThrow("Local Host connection is unavailable");
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).not.toHaveProperty("abandon");
    expect(payloads[0]).toMatchObject({
      v: 1,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      method: VOICE_GATEWAY_STATUS_METHOD,
    });
    expect(payloads[1]).toEqual({
      v: 1,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      owner: "owner-1",
      generation: 1,
      abandon: true,
      method: VOICE_GATEWAY_STATUS_METHOD,
      params: {},
    });
  });

  it("dispose settles pending waiters as unknown and does not deliver later success", async () => {
    const renderer = fakeRenderer();
    let release: (value: unknown) => void = () => undefined;
    const pendingHost = new Promise((resolve) => {
      release = resolve;
    });
    const owner = host();
    owner.request.mockImplementation(async () => {
      await pendingHost;
      return { initialized: true };
    });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ id: "late" }),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    dispose();
    expect(JSON.stringify(renderer.evaluate.mock.calls)).toContain(
      "Host request outcome is unknown",
    );
    release(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes('"ok":true')),
    ).toHaveLength(0);
  });

  it("cancels an abandoned create and hangs up a returned identity instead of retrying", async () => {
    const renderer = fakeRenderer();
    let release: (value: unknown) => void = () => undefined;
    const created = new Promise((resolve) => {
      release = resolve;
    });
    const owner = host();
    owner.request.mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      if (params.operation === "create") {
        await created;
        return {
          status: 201,
          body: "",
          headers: { location: "/realtime/calls/call-123" },
        };
      }
      return { status: 204, body: "", headers: {} };
    });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({
        id: "create-1",
        method: REALTIME_CALL_METHOD,
        params: {
          operation: "create",
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          body: "{}",
        },
      }),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    dispose();
    release(undefined);
    await vi.waitFor(() =>
      expect(owner.request.mock.calls.some(([, value]) => value.operation === "cancel")).toBe(true),
    );
    await vi.waitFor(() =>
      expect(owner.request.mock.calls.some(([, value]) => value.operation === "hangup")).toBe(true),
    );
    expect(
      owner.request.mock.calls.filter(([, value]) => value.operation === "create"),
    ).toHaveLength(1);
    expect(
      owner.request.mock.calls.filter(([, value]) => value.operation === "cancel"),
    ).toHaveLength(1);
    expect(
      owner.request.mock.calls.filter(([, value]) => value.operation === "hangup"),
    ).toHaveLength(1);
    const delivered = renderer.commands
      .map(evaluateExpression)
      .filter((expression) => expression.includes('"ok":true'));
    expect(delivered).toHaveLength(0);
  });

  it("propagates an allowlisted gateway stage on the direct Host path", async () => {
    const renderer = fakeRenderer();
    const { owner, dispose } = await bindReady(renderer);
    owner.request.mockRejectedValue(
      Object.assign(new Error("Configured voice gateway request failed"), { stage: "identity" }),
    );
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({
        id: "create-stage",
        method: REALTIME_CALL_METHOD,
        params: {
          operation: "create",
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          body: "{}",
        },
      }),
    });
    await vi.waitFor(() => {
      const expressions = renderer.commands.map(evaluateExpression).join("\n");
      expect(expressions).toContain('"ok":false');
      expect(expressions).toContain('"stage":"identity"');
    });
    owner.request.mockRejectedValue(
      Object.assign(new Error("Configured voice gateway request failed"), { stage: "secret-lab" }),
    );
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({
        id: "create-dropped-stage",
        method: REALTIME_CALL_METHOD,
        params: {
          operation: "create",
          requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          body: "{}",
        },
      }),
    });
    await vi.waitFor(() =>
      expect(
        renderer.commands.map(evaluateExpression).join("\n").includes("create-dropped-stage"),
      ).toBe(true),
    );
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain("secret-lab");
    expect(owner.request).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("removes a late-added future script when dispose wins the add race", async () => {
    const renderer = fakeRenderer();
    const listeners: Array<() => void> = [];
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    let generation = 1;
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.holdNextAdd = true;
    generation = 2;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(renderer.addHolds).toHaveLength(1));
    dispose();
    renderer.addHolds[0]?.();
    await vi.waitFor(() =>
      expect(
        renderer.commands.some(
          (item) =>
            item.method === "Page.removeScriptToEvaluateOnNewDocument" &&
            item.params?.identifier === "script-2",
        ),
      ).toBe(true),
    );
  });

  it("cancels and hangs up a late create after page timeout abandonment", async () => {
    const renderer = fakeRenderer();
    let release: (value: unknown) => void = () => undefined;
    const created = new Promise((resolve) => {
      release = resolve;
    });
    const owner = host();
    owner.request.mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      if (params.operation === "create") {
        await created;
        return createdCallResult();
      }
      return { status: 204, body: "", headers: {} };
    });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: createPayload(),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({
        id: "create-1",
        abandon: true,
        method: REALTIME_CALL_METHOD,
        params: {
          operation: "create",
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          body: "{}",
        },
      }),
    });
    release(undefined);
    await vi.waitFor(() => expectAbandonedCreate(owner.request));
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes('"ok":true')),
    ).toHaveLength(0);
    dispose();
  });

  it("cleans up a create when its execution context is destroyed before the result", async () => {
    const renderer = fakeRenderer();
    let release: (value: unknown) => void = () => undefined;
    const created = new Promise((resolve) => {
      release = resolve;
    });
    const owner = host();
    owner.request.mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      if (params.operation === "create") {
        await created;
        return createdCallResult();
      }
      return { status: 204, body: "", headers: {} };
    });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: createPayload(),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    renderer.emit("Runtime.executionContextDestroyed", { executionContextId: 1 });
    release(undefined);
    await vi.waitFor(() => expectAbandonedCreate(owner.request));
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes('"ok":true')),
    ).toHaveLength(0);
    dispose();
  });

  it("does not recover a missed-created isolated world from an eligible href", async () => {
    const renderer = fakeRenderer();
    renderer.hrefByContext[3] = "app://-/index.html";
    renderer.topByContext[3] = true;
    const { owner, dispose } = await bindReady(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 3,
      payload: payload({ id: "missed-isolated" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(owner.request).not.toHaveBeenCalled();
    const hrefReads = renderer.commands.filter(
      (item) =>
        item.method === "Runtime.evaluate" &&
        item.params?.contextId === 3 &&
        typeof item.params.expression === "string" &&
        item.params.expression.includes("href:String(location.href)"),
    );
    expect(hrefReads).toHaveLength(0);
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain("missed-isolated");
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain('"ok":true');
    dispose();
  });

  it("does not request after a tracked default context is destroyed during document verification", async () => {
    const renderer = fakeRenderer();
    renderer.holdHref = true;
    const { owner, dispose } = await bindReady(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ id: "destroyed-during-verify" }),
    });
    await vi.waitFor(() => expect(renderer.hrefHolds).toHaveLength(1));
    renderer.emit("Runtime.executionContextDestroyed", { executionContextId: 1 });
    delete renderer.hrefByContext[1];
    renderer.topByContext[1] = false;
    renderer.hrefHolds[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(owner.request).not.toHaveBeenCalled();
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain(
      "destroyed-during-verify",
    );
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain('"ok":true');
    dispose();
  });

  it("delivers cleanup-unconfirmed when original-owner hangup fails after a skipped late create", async () => {
    const renderer = fakeRenderer();
    let release: (value: unknown) => void = () => undefined;
    const created = new Promise((resolve) => {
      release = resolve;
    });
    const unconfirmed = Object.assign(new Error(RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED), {
      code: -32093,
      stage: "cancel",
    });
    const requestA = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.operation === "create") {
        await created;
        return createdCallResult();
      }
      throw unconfirmed;
    });
    const requestB = vi.fn(async () => {
      throw new Error("replacement owner must not receive cleanup");
    });
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      bindExecution() {
        return generation === 1
          ? { generation: 1, request: requestA }
          : { generation: 2, request: requestB };
      },
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: createPayload(),
    });
    await vi.waitFor(() => expect(requestA).toHaveBeenCalledOnce());
    generation = 2;
    for (const listener of listeners) listener();
    release(undefined);
    await vi.waitFor(() => {
      const expressions = renderer.commands.map(evaluateExpression).join("\n");
      expect(expressions).toContain(RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED);
      expect(expressions).toContain('"stage":"cancel"');
    });
    await vi.waitFor(() =>
      expect(operations(requestA).filter((operation) => operation === "hangup")).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes(RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED)),
    ).toHaveLength(1);
    expect(requestB).not.toHaveBeenCalled();
    expect(owner.request).not.toHaveBeenCalled();
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes('"ok":true')),
    ).toHaveLength(0);
    dispose();
  });

  it("does not request or deliver after numeric context uniqueId reuse during document verification", async () => {
    const renderer = fakeRenderer();
    renderer.holdHref = true;
    const { owner, dispose } = await bindReady(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ id: "reused" }),
    });
    await vi.waitFor(() => expect(renderer.hrefHolds).toHaveLength(1));
    emitDefaultContext(renderer, 1, "ctx-reused");
    renderer.hrefHolds[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(owner.request).not.toHaveBeenCalled();
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain("reused");
    expect(renderer.commands.map(evaluateExpression).join("\n")).not.toContain('"ok":true');
    dispose();
  });

  it("cleans up a late create through the original execution after owner generation B", async () => {
    const renderer = fakeRenderer();
    let release: (value: unknown) => void = () => undefined;
    const created = new Promise((resolve) => {
      release = resolve;
    });
    const requestA = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.operation === "create") {
        await created;
        return createdCallResult();
      }
      return { status: 204, body: "", headers: {} };
    });
    const requestB = vi.fn(async () => {
      throw new Error("replacement owner must not receive cleanup");
    });
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      bindExecution() {
        return generation === 1
          ? { generation: 1, request: requestA }
          : { generation: 2, request: requestB };
      },
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: createPayload(),
    });
    await vi.waitFor(() => expect(requestA).toHaveBeenCalledOnce());
    generation = 2;
    for (const listener of listeners) listener();
    release(undefined);
    await vi.waitFor(() => expectAbandonedCreate(requestA));
    expect(requestB).not.toHaveBeenCalled();
    expect(owner.request).not.toHaveBeenCalled();
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes('"ok":true')),
    ).toHaveLength(0);
    dispose();
  });

  it("installs context and binding listeners before the capability can issue requests", async () => {
    const renderer = fakeRenderer();
    const { dispose } = await bindReady(renderer);
    const order = renderer.events;
    const runtimeEnable = order.indexOf("command:Runtime.enable");
    const addBinding = order.indexOf("command:Runtime.addBinding");
    const publish = order.indexOf("evaluate:publish");
    expect(order.indexOf("on:Runtime.executionContextCreated")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("on:Runtime.executionContextDestroyed")).toBeLessThan(runtimeEnable);
    expect(order.indexOf("on:Runtime.executionContextsCleared")).toBeLessThan(runtimeEnable);
    expect(order.indexOf("on:Runtime.bindingCalled")).toBeLessThan(addBinding);
    expect(order.indexOf("on:Runtime.bindingCalled")).toBeLessThan(publish);
    expect(addBinding).toBeLessThan(publish);
    dispose();
  });

  it("publishes the newest generation when it changes during the initial future script", async () => {
    const renderer = fakeRenderer();
    let generation = 1;
    const owner = host();
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    renderer.holdNextAdd = true;
    const installing = installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    await vi.waitFor(() => expect(renderer.addHolds).toHaveLength(1));
    generation = 2;
    renderer.addHolds[0]?.();
    const dispose = await installing;
    const added = renderer.commands.filter(
      (item) => item.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(added).toHaveLength(2);
    expect(String(added[0]?.params?.source)).toContain("const generation = 1");
    expect(String(added[1]?.params?.source)).toContain("const generation = 2");
    expect(
      renderer.commands.some(
        (item) =>
          item.method === "Page.removeScriptToEvaluateOnNewDocument" &&
          item.params?.identifier === "script-1",
      ),
    ).toBe(true);
    const published = publishExpressions(renderer);
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("const generation = 2");
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ generation: 2 }),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    expect(owner.request).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("republishes when the generation changes during the initial capability evaluation", async () => {
    const renderer = fakeRenderer();
    let generation = 1;
    const owner = host();
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    renderer.holdNextPublish = true;
    const installing = installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    await vi.waitFor(() => expect(renderer.publishHolds).toHaveLength(1));
    generation = 2;
    renderer.publishHolds[0]?.();
    const dispose = await installing;
    const published = publishExpressions(renderer);
    expect(published).toHaveLength(2);
    expect(published[0]).toContain("const generation = 1");
    expect(published[1]).toContain("const generation = 2");
    dispose();
  });

  it("does not publish twice when a generation change races the initial publish", async () => {
    const renderer = fakeRenderer();
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    renderer.holdNextAdd = true;
    const installing = installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    await vi.waitFor(() => expect(renderer.addHolds).toHaveLength(1));
    generation = 2;
    for (const listener of listeners) listener();
    renderer.addHolds[0]?.();
    const dispose = await installing;
    const published = publishExpressions(renderer);
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("const generation = 2");
    expect(renderer.events.filter((event) => event === "on:Runtime.bindingCalled")).toHaveLength(1);
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: payload({ generation: 2 }),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());
    expect(owner.request).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("keeps a replacement capability and its pending request across an asynchronous dispose", async () => {
    const sandbox = pageSandbox();
    const owner = host();
    const disposeFirst = await installRendererVoiceHostBinding(
      pageRenderer(sandbox) as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    const original = pageCapability(sandbox);
    expect(original?.generation).toBe(1);
    const disposeSecond = await installRendererVoiceHostBinding(
      pageRenderer(sandbox) as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    const replacement = pageCapability(sandbox);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(original);
    let outcome: string | undefined;
    const pending = replacement?.request(VOICE_SETTINGS_METHOD, { operation: "get" });
    void pending?.then(
      () => {
        outcome = "resolved";
      },
      (error: Error) => {
        outcome = `rejected:${error.message}`;
      },
    );
    await vi.waitFor(() => expect(pageBindingCalls(sandbox)).toHaveLength(1));
    disposeFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pageCapability(sandbox)).toBe(replacement);
    expect(outcome).toBeUndefined();
    void replacement?.request(VOICE_GATEWAY_STATUS_METHOD, {}).catch(() => undefined);
    expect(pageBindingCalls(sandbox)).toHaveLength(2);
    disposeSecond();
    await vi.waitFor(() => expect(pageCapability(sandbox)).toBeUndefined());
    await vi.waitFor(() =>
      expect(outcome).toBe("rejected:Host request outcome is unknown. Do not retry automatically."),
    );
  });

  it("replaces capability state retained from an earlier Controller process", () => {
    const sandbox = pageSandbox();
    vm.runInNewContext(
      rendererVoiceHostCapabilitySource("old-owner", 4, "old-instance", 50, "old-process"),
      sandbox,
    );
    vm.runInNewContext(
      rendererVoiceHostCapabilitySource("new-owner", 1, "new-instance", 1, "new-process"),
      sandbox,
    );
    expect(pageCapability(sandbox)?.instance).toBe("new-instance");
    expect(pageCapability(sandbox)?.generation).toBe(1);
  });

  it("does not publish into the current document when dispose wins the previous-script removal", async () => {
    const sandbox = pageSandbox();
    const renderer = pageRenderer(sandbox);
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    expect(pageCapability(sandbox)?.generation).toBe(1);

    renderer.holdNextRemove = true;
    generation = 2;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(renderer.removeHolds).toHaveLength(1));
    dispose();
    expect(pageCapability(sandbox)).toBeUndefined();
    renderer.removeHolds[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pageCapability(sandbox)).toBeUndefined();
    // The disposal window must not evaluate a second capability into the document.
    expect(publishExpressions(renderer)).toHaveLength(1);
  });

  it("does not leave page globals when dispose wins the current-document publish", async () => {
    const sandbox = pageSandbox();
    const renderer = pageRenderer(sandbox);
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );

    renderer.holdNextPagePublish = true;
    generation = 2;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(renderer.pagePublishHolds).toHaveLength(1));
    dispose();
    expect(pageCapability(sandbox)).toBeUndefined();
    renderer.pagePublishHolds[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pageCapability(sandbox)).toBeUndefined();
    expect(sandbox[RENDERER_VOICE_HOST_DELIVER_GLOBAL]).toBeUndefined();
    expect(sandbox[RENDERER_VOICE_HOST_PENDING_GLOBAL]).toBeUndefined();
  });

  it("does not let a late publish from a disposed installation replace a replacement capability", async () => {
    const sandbox = pageSandbox();
    const rendererA = pageRenderer(sandbox);
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const disposeA = await installRendererVoiceHostBinding(
      rendererA as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    rendererA.holdNextPagePublish = true;
    generation = 2;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(rendererA.pagePublishHolds).toHaveLength(1));

    const disposeB = await installRendererVoiceHostBinding(
      pageRenderer(sandbox) as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    const replacement = pageCapability(sandbox);
    expect(replacement?.generation).toBe(2);
    let outcome: string | undefined;
    const pending = replacement?.request(VOICE_SETTINGS_METHOD, { operation: "get" });
    void pending?.then(
      () => {
        outcome = "resolved";
      },
      (error: Error) => {
        outcome = `rejected:${error.message}`;
      },
    );
    await vi.waitFor(() => expect(pageBindingCalls(sandbox)).toHaveLength(1));

    disposeA();
    rendererA.pagePublishHolds[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pageCapability(sandbox)).toBe(replacement);
    expect(outcome).toBeUndefined();

    disposeB();
    await vi.waitFor(() => expect(pageCapability(sandbox)).toBeUndefined());
    await vi.waitFor(() =>
      expect(outcome).toBe("rejected:Host request outcome is unknown. Do not retry automatically."),
    );
  });

  it("keeps the previous future script across a rejected registration and republishes on retry", async () => {
    vi.useFakeTimers();
    const sandbox = pageSandbox();
    const renderer = pageRenderer(sandbox);
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    const adds = () =>
      renderer.commands.filter((item) => item.method === "Page.addScriptToEvaluateOnNewDocument");
    const removes = () =>
      renderer.commands.filter(
        (item) => item.method === "Page.removeScriptToEvaluateOnNewDocument",
      );
    const previousSource = String(adds()[0]?.params?.source);
    expect(previousSource).toContain("const generation = 1");
    expect(pageCapability(sandbox)?.generation).toBe(1);

    generation = 2;
    renderer.failNextAdd = true;
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(adds()).toHaveLength(2);
    expect(String(adds()[1]?.params?.source)).toContain("const generation = 2");
    // The rejected registration leaves the previous script for future documents.
    expect(removes()).toHaveLength(0);
    expect(pageCapability(sandbox)?.generation).toBe(1);
    const retainedDocument = pageSandbox();
    vm.runInNewContext(previousSource, retainedDocument);
    expect(pageCapability(retainedDocument)?.generation).toBe(1);

    await vi.advanceTimersByTimeAsync(RENDERER_VOICE_HOST_PUBLISH_RETRY_MS);
    expect(adds()).toHaveLength(3);
    expect(String(adds()[2]?.params?.source)).toContain("const generation = 2");
    expect(removes().map((item) => item.params?.identifier)).toContain("script-1");
    expect(pageCapability(sandbox)?.generation).toBe(2);
    const futureDocument = pageSandbox();
    vm.runInNewContext(String(adds()[2]?.params?.source), futureDocument);
    expect(pageCapability(futureDocument)?.generation).toBe(2);
    dispose();
  });

  it("stops retrying a failed publication after dispose", async () => {
    vi.useFakeTimers();
    const renderer = fakeRenderer();
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    generation = 2;
    renderer.failNextAdd = true;
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    const attempts = () =>
      renderer.commands.filter((item) => item.method === "Page.addScriptToEvaluateOnNewDocument");
    expect(attempts()).toHaveLength(2);
    dispose();
    await vi.advanceTimersByTimeAsync(RENDERER_VOICE_HOST_PUBLISH_RETRY_MS * 3);
    expect(attempts()).toHaveLength(2);
  });

  it("keeps the previous future script when a refresh add loses the generation race", async () => {
    const renderer = fakeRenderer();
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    generation = 2;
    renderer.holdNextAdd = true;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(renderer.addHolds).toHaveLength(1));
    generation = 3;
    renderer.addHolds[0]?.();
    await vi.waitFor(() => expect(publishExpressions(renderer)).toHaveLength(2));
    const adds = renderer.commands.filter(
      (item) => item.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(adds).toHaveLength(3);
    expect(String(adds[1]?.params?.source)).toContain("const generation = 2");
    expect(String(adds[2]?.params?.source)).toContain("const generation = 3");
    // The script that lost the generation race is removed; the previous script is
    // replaced only by the accepted generation.
    expect(
      renderer.commands
        .filter((item) => item.method === "Page.removeScriptToEvaluateOnNewDocument")
        .map((item) => item.params?.identifier),
    ).toEqual(["script-2", "script-1"]);
    expect(publishExpressions(renderer)[1]).toContain("const generation = 3");
    dispose();
  });

  it("rejects a failed initial registration without leaving a binding and installs again on the same owner", async () => {
    const renderer = fakeRenderer();
    const owner = host();
    renderer.failNextAdd = true;
    await expect(
      installRendererVoiceHostBinding(renderer as unknown as RendererVoiceHostCdpClient, owner),
    ).rejects.toThrow("Page.addScriptToEvaluateOnNewDocument failed");
    expect(renderer.commands.some((item) => item.method === "Runtime.removeBinding")).toBe(true);
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    const scripts = renderer.commands.filter(
      (item) => item.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(scripts).toHaveLength(2);
    expect(String(scripts[1]?.params?.source)).toContain("const generation = 1");
    dispose();
  });

  it("cancels a pending create once across generation refresh, context destruction, and dispose", async () => {
    const renderer = fakeRenderer();
    const listeners: Array<() => void> = [];
    let generation = 1;
    let release: (value: unknown) => void = () => undefined;
    const created = new Promise((resolve) => {
      release = resolve;
    });
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    owner.request.mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      if (params.operation === "create") {
        await created;
        return createdCallResult();
      }
      return { status: 204, body: "", headers: {} };
    });
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: createPayload(),
    });
    await vi.waitFor(() => expect(owner.request).toHaveBeenCalledOnce());

    generation = 2;
    for (const listener of listeners) listener();
    renderer.emit("Runtime.executionContextDestroyed", { executionContextId: 1 });
    dispose();
    await vi.waitFor(() =>
      expect(operations(owner.request).filter((operation) => operation === "cancel")).toHaveLength(
        1,
      ),
    );
    release(undefined);
    await vi.waitFor(() => expectAbandonedCreate(owner.request));
    for (const [, params] of owner.request.mock.calls)
      if (params.operation !== "create")
        expect(realtimeCallParamsSchema.safeParse(params).success).toBe(true);
    expect(
      renderer.commands
        .map(evaluateExpression)
        .filter((expression) => expression.includes('"ok":true')),
    ).toHaveLength(0);
  });

  it("hangs up a settled create once without cancelling it", async () => {
    const renderer = fakeRenderer();
    const listeners: Array<() => void> = [];
    let generation = 1;
    const owner = host({
      onGenerationChange(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    Object.defineProperty(owner, "generation", { get: () => generation, configurable: true });
    owner.request.mockImplementation(async (_method: string, params: Record<string, unknown>) =>
      params.operation === "create" ? createdCallResult() : { status: 204, body: "", headers: {} },
    );
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      owner,
    );
    emitDefaultContext(renderer);
    renderer.holdNextDeliver = true;
    renderer.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: createPayload(),
    });
    await vi.waitFor(() => expect(renderer.deliverHolds).toHaveLength(1));

    generation = 2;
    for (const listener of listeners) listener();
    await vi.waitFor(() =>
      expect(operations(owner.request).filter((operation) => operation === "hangup")).toHaveLength(
        1,
      ),
    );
    expect(operations(owner.request)).not.toContain("cancel");
    dispose();
    renderer.deliverHolds[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(operations(owner.request).filter((operation) => operation === "hangup")).toHaveLength(1);
  });
});
