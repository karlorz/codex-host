import {
  IDLE_RELEASE_SETTINGS_METHOD,
  idleReleaseSettingsSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installCurrentRendererAdapter } from "../src/versioned-renderer-adapter.js";
import { installRendererExternalQueue } from "../src/renderer-external-queue.js";

interface QueuedMessage {
  id: string;
  text: string;
  context: { prompt: string };
  pausedReason?: string;
}

function fixture() {
  const conversations = new Map([
    ["external", { id: "external", modelProvider: "codexhost" }],
    ["native", { id: "native", modelProvider: "openai" }],
  ]);
  const local = new Map<string, QueuedMessage[]>();
  const remote = new Map<string, QueuedMessage[]>();
  const rpc = vi.fn(async (method: string, params: { threadId: string }) => {
    if (conversations.get(params.threadId)?.modelProvider === "codexhost") {
      throw Object.assign(new Error(`External Thread does not support ${method}`), {
        code: -32076,
      });
    }
    return { data: remote.get(params.threadId) ?? [], nextCursor: null };
  });
  const queue = {
    isEnabled: vi.fn<(threadId?: unknown) => boolean>(() => true),
    read: (threadId: string) => remote.get(threadId),
    load: async (threadId: string) => {
      const result = await rpc("thread/queue/list", { threadId });
      remote.set(threadId, result.data);
    },
    enqueue: async (threadId: string, message: QueuedMessage) => {
      await rpc("thread/queue/add", { threadId });
      remote.set(threadId, [...(remote.get(threadId) ?? []), message]);
      return { status: "queued", messageId: message.id };
    },
  };
  // Desktop 26.903.61454 selects the server queue only when isEnabled(threadId)
  // and the legacy local queue is empty. All queue operations go through this
  // same selection; an empty thread/queue/list reply alone cannot fix admission.
  class Coordinator {
    serverQueue: typeof queue | undefined = queue;

    #selectedQueue(threadId: string) {
      return this.serverQueue?.isEnabled(threadId) && (local.get(threadId) ?? []).length === 0
        ? this.serverQueue
        : undefined;
    }
    loadMessages = async (threadId: string) => {
      const selected = this.#selectedQueue(threadId);
      if (selected && selected.read(threadId) == null) await selected.load(threadId);
    };
    readMessages(threadId: string) {
      return this.#selectedQueue(threadId)?.read(threadId) ?? local.get(threadId) ?? [];
    }
    async sendMessage({
      conversationId,
      message,
    }: {
      conversationId: string;
      message: QueuedMessage;
    }) {
      // The running-Turn / queue branch of Desktop's sendMessage.
      await this.loadMessages(conversationId);
      const selected = this.#selectedQueue(conversationId);
      if (selected) return selected.enqueue(conversationId, message);
      local.set(conversationId, [...(local.get(conversationId) ?? []), message]);
      return { status: "queued", messageId: message.id };
    }
  }
  const coordinator = new Coordinator();
  class Manager {
    readonly hostId = "local";
    readonly #conversations = conversations;
    async sendRequest(method: string, params: unknown) {
      // Settings sync shares the connection but is not a queue operation.
      if (method === IDLE_RELEASE_SETTINGS_METHOD) return idleReleaseSettingsSchema.parse(params);
      if (
        method.startsWith("thread/queue/") &&
        params !== null &&
        typeof params === "object" &&
        "threadId" in params &&
        typeof params.threadId === "string"
      ) {
        return rpc(method, { threadId: params.threadId });
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }
    prewarmThreadStart = vi.fn();
    enqueueRequest = vi.fn();
    getConversation(threadId: string) {
      return this.#conversations.get(threadId) ?? null;
    }
    getTurnCoordinator() {
      return coordinator;
    }
  }
  const manager = new Manager();
  const install = () => {
    const policy = {
      state: "ready",
      hostId: "local",
      requestTarget: () => manager,
      select: () => true,
      clear: async () => undefined,
    };
    const route = { hostId: "local", manager, policy };
    vi.stubGlobal("window", {
      __codexhostHostRoutingV1: {
        forHost: (hostId: string) => (hostId === "local" ? route : null),
        forComposer: () => route,
        hostIdForComposer: () => "local",
      },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const adapter = installCurrentRendererAdapter();
    expect(adapter.status.state).toBe("ready");
    return adapter;
  };
  const message: QueuedMessage = {
    id: "follow-up",
    text: "next task",
    context: { prompt: "next task" },
  };
  return {
    manager,
    coordinator,
    queue,
    originalGate: queue.isEnabled,
    local,
    conversations,
    rpc,
    install,
    message,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("external follow-ups retain Desktop's local queue", () => {
  it("leaves the server queue enabled when the Manager reports stream role", () => {
    const f = fixture();
    Object.assign(f.manager, { getStreamRole: () => ({ role: "follower" }) });
    const adapter = f.install();
    try {
      expect(f.queue.isEnabled).toBe(f.originalGate);
      expect(f.queue.isEnabled("external")).toBe(true);
    } finally {
      adapter.dispose();
    }
  });

  it("queues another message during an external Turn without thread/queue/list or add", async () => {
    const f = fixture();
    const adapter = f.install();
    try {
      await expect(
        f.coordinator.sendMessage({ conversationId: "external", message: f.message }),
      ).resolves.toEqual({ status: "queued", messageId: f.message.id });
      expect(f.coordinator.readMessages("external")).toEqual([f.message]);
      expect(f.local.get("external")).toEqual([f.message]);
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });

  it("preserves existing paused follow-ups and stays local after the queue drains", async () => {
    const f = fixture();
    const paused = {
      ...f.message,
      id: "paused",
      pausedReason: "Interrupted before the steer was accepted.",
    };
    f.local.set("external", [paused]);
    const adapter = f.install();
    try {
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.local.get("external")).toEqual([paused, f.message]);
      f.local.delete("external");
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.local.get("external")).toEqual([f.message]);
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });

  it("keeps native Threads on the enabled server queue on the same connection", async () => {
    const f = fixture();
    const adapter = f.install();
    try {
      await f.coordinator.sendMessage({ conversationId: "native", message: f.message });
      expect(f.rpc.mock.calls).toEqual([
        ["thread/queue/list", { threadId: "native" }],
        ["thread/queue/add", { threadId: "native" }],
      ]);
      expect(f.local.has("native")).toBe(false);
      expect(f.coordinator.readMessages("native")).toEqual([f.message]);
      expect(f.queue.isEnabled("external")).toBe(false);
      expect(f.queue.isEnabled("native")).toBe(true);
      expect(f.originalGate.mock.contexts.every((receiver) => receiver === f.queue)).toBe(true);
    } finally {
      adapter.dispose();
    }
  });

  it("reads current per-manager Thread metadata rather than the selected Agent or an ID cache", () => {
    const f = fixture();
    const other = fixture();
    const adapter = f.install();
    try {
      expect(f.queue.isEnabled("external")).toBe(false);
      expect(other.queue.isEnabled("external")).toBe(true);
      f.conversations.set("native", { id: "native", modelProvider: "codexhost" });
      expect(f.queue.isEnabled("native")).toBe(false);
      expect(f.queue.isEnabled("unloaded")).toBe(true);
      expect(f.queue.isEnabled()).toBe(true);
      f.originalGate.mockReturnValue(false);
      expect(f.queue.isEnabled("unloaded")).toBe(false);
    } finally {
      adapter.dispose();
    }
  });

  it("restores the original gate on uninstall and can install again", () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const adapter = f.install();
      expect(f.queue.isEnabled("external")).toBe(false);
      adapter.dispose();
      expect(f.queue.isEnabled).toBe(f.originalGate);
      expect(Object.hasOwn(f.manager, "getTurnCoordinator")).toBe(false);
    }
  });

  it("requires matching external Thread metadata and does not overwrite a later wrapper", () => {
    const f = fixture();
    const adapter = f.install();
    try {
      f.conversations.set("native", { id: "different-thread", modelProvider: "codexhost" });
      expect(f.queue.isEnabled("native")).toBe(true);
      f.conversations.delete("external");
      expect(f.queue.isEnabled("external")).toBe(true);
      f.conversations.set("external", { id: "external", modelProvider: "codexhost" });
      expect(f.queue.isEnabled("external")).toBe(false);
      const replacement = vi.fn(() => false);
      f.queue.isEnabled = replacement;
      adapter.dispose();
      expect(f.queue.isEnabled).toBe(replacement);
    } finally {
      adapter.dispose();
    }
  });

  it("does not patch a server queue with an incompatible gate property", () => {
    const f = fixture();
    Object.defineProperty(f.queue, "isEnabled", { writable: false });
    const adapter = f.install();
    try {
      expect(f.queue.isEnabled).toBe(f.originalGate);
    } finally {
      adapter.dispose();
    }
  });

  it("leaves older Desktop coordinators without a server queue unchanged", async () => {
    const f = fixture();
    f.coordinator.serverQueue = undefined;
    const adapter = f.install();
    try {
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.local.get("external")).toEqual([f.message]);
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });
});

describe("external follow-ups drain the Host server queue", () => {
  function drainFixture(role: "owner" | "follower" = "owner") {
    const conversations = new Map([
      [
        "external",
        {
          id: "external",
          modelProvider: "codexhost",
          threadRuntimeStatus: { type: "idle" },
        },
      ],
      ["native", { id: "native", modelProvider: "openai", threadRuntimeStatus: { type: "idle" } }],
    ]);
    const queued = new Map<string, Array<{ id: string; pausedReason?: string }>>([
      ["external", [{ id: "queued-1" }]],
    ]);
    const sendRequest = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    const listeners = new Map<string, Set<(notification: unknown) => void>>();
    const submissionHost = {
      activeTurnId: null as string | null,
      pendingStart: false,
      getActiveTurnId(threadId: string) {
        return threadId === "external" ? this.activeTurnId : null;
      },
      hasPendingTurnStart(threadId: string) {
        return threadId === "external" ? this.pendingStart : false;
      },
    };
    const coordinator = {
      options: { submissionHost },
      readMessages(threadId: string) {
        return queued.get(threadId) ?? [];
      },
      serverQueue: {
        isEnabled: () => true,
        read(threadId: string) {
          return queued.get(threadId) ?? [];
        },
      },
    };
    const manager = {
      getStreamRole: vi.fn((threadId: string) =>
        threadId === "external" ? { role } : { role: "owner" },
      ),
      getConversation: (threadId: string) => conversations.get(threadId) ?? null,
      getTurnCoordinator: () => coordinator,
      sendRequest,
      addNotificationCallback(
        methods: string | readonly string[],
        listener: (notification: unknown) => void,
      ) {
        for (const method of typeof methods === "string" ? [methods] : methods) {
          const set = listeners.get(method) ?? new Set();
          set.add(listener);
          listeners.set(method, set);
        }
        return () => {
          for (const method of typeof methods === "string" ? [methods] : methods) {
            listeners.get(method)?.delete(listener);
          }
        };
      },
    };
    const emit = (notification: unknown) => {
      if (!notification || typeof notification !== "object" || !("method" in notification)) return;
      for (const listener of listeners.get(String(notification.method)) ?? [])
        listener(notification);
    };
    return { manager, sendRequest, emit, queued, submissionHost };
  }

  it("starts the Host queued follow-up when an External Turn completes", async () => {
    const f = drainFixture();
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      f.emit({
        method: "turn/completed",
        params: { threadId: "external", turn: { status: "completed" } },
      });
      await Promise.resolve();
      expect(f.sendRequest).toHaveBeenCalledWith("thread/queue/start", {
        threadId: "external",
        queuedSubmissionId: "queued-1",
      });
    } finally {
      cleanup?.();
    }
  });

  it("starts an idle Host queue after thread/queue/changed", async () => {
    const f = drainFixture();
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      f.emit({ method: "thread/queue/changed", params: { threadId: "external" } });
      await Promise.resolve();
      expect(f.sendRequest).toHaveBeenCalledWith("thread/queue/start", {
        threadId: "external",
        queuedSubmissionId: "queued-1",
      });
    } finally {
      cleanup?.();
    }
  });

  it("does not start while a Turn is still active", async () => {
    const f = drainFixture();
    f.submissionHost.activeTurnId = "turn-1";
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      f.emit({
        method: "turn/completed",
        params: { threadId: "external", turn: { status: "completed" } },
      });
      await Promise.resolve();
      expect(f.sendRequest).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
    }
  });

  it("does not start an interrupted Turn's follow-up", async () => {
    const f = drainFixture();
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      f.emit({
        method: "turn/completed",
        params: { threadId: "external", turn: { status: "interrupted" } },
      });
      await Promise.resolve();
      expect(f.sendRequest).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
    }
  });

  it("does not start from a follower window", async () => {
    const f = drainFixture("follower");
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      f.emit({
        method: "turn/completed",
        params: { threadId: "external", turn: { status: "completed" } },
      });
      await Promise.resolve();
      expect(f.sendRequest).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
    }
  });

  it("does not start a native Codex queue", async () => {
    const f = drainFixture();
    f.queued.set("native", [{ id: "native-1" }]);
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      f.emit({
        method: "turn/completed",
        params: { threadId: "native", turn: { status: "completed" } },
      });
      await Promise.resolve();
      expect(f.sendRequest).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
    }
  });

  it("skips a paused Host follow-up", async () => {
    const f = drainFixture();
    f.queued.set("external", [
      { id: "queued-1", pausedReason: "Interrupted before the steer was accepted." },
    ]);
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      f.emit({
        method: "turn/completed",
        params: { threadId: "external", turn: { status: "completed" } },
      });
      await Promise.resolve();
      expect(f.sendRequest).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
    }
  });

  it("keeps the native getStreamRole after steering later claims owner", async () => {
    const f = drainFixture("follower");
    const cleanup = installRendererExternalQueue(f.manager);
    try {
      Object.assign(f.manager, { getStreamRole: () => ({ role: "owner" }) });
      f.emit({
        method: "turn/completed",
        params: { threadId: "external", turn: { status: "completed" } },
      });
      await Promise.resolve();
      expect(f.sendRequest).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
    }
  });

  it("stops draining after uninstall", async () => {
    const f = drainFixture();
    const cleanup = installRendererExternalQueue(f.manager);
    cleanup?.();
    f.emit({
      method: "turn/completed",
      params: { threadId: "external", turn: { status: "completed" } },
    });
    await Promise.resolve();
    expect(f.sendRequest).not.toHaveBeenCalled();
  });
});
