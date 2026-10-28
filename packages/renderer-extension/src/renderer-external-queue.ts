function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RendererMethod = (...args: unknown[]) => unknown;

function notificationTarget(
  manager: Record<string, unknown>,
): { addNotificationCallback: RendererMethod } | null {
  if (typeof manager.addNotificationCallback === "function") {
    return manager as { addNotificationCallback: RendererMethod };
  }
  const nested = manager.requestClient;
  return isRecord(nested) && typeof nested.addNotificationCallback === "function"
    ? (nested as { addNotificationCallback: RendererMethod })
    : null;
}

function notificationParams(notification: unknown): Record<string, unknown> | null {
  if (!isRecord(notification)) return null;
  return isRecord(notification.params) ? notification.params : notification;
}

function notificationThreadId(notification: unknown): string | null {
  const params = notificationParams(notification);
  if (!params) return null;
  if (typeof params.threadId === "string" && params.threadId) return params.threadId;
  if (typeof params.conversationId === "string" && params.conversationId)
    return params.conversationId;
  return null;
}

function turnStatus(notification: unknown): string | null {
  const params = notificationParams(notification);
  if (!params) return null;
  if (typeof params.status === "string") return params.status;
  const turn = params.turn;
  return isRecord(turn) && typeof turn.status === "string" ? turn.status : null;
}

function isExternalConversation(conversation: unknown, threadId: string): boolean {
  return (
    isRecord(conversation) &&
    conversation.id === threadId &&
    conversation.modelProvider === "codexhost"
  );
}

function firstQueuedItemId(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!isRecord(item) || item.pausedReason != null) continue;
    if (typeof item.id === "string" && item.id) return item.id;
  }
  return null;
}

function removeQueuedItem(
  coordinator: unknown,
  threadId: string,
  queuedSubmissionId: string,
): void {
  if (!isRecord(coordinator) || typeof coordinator.mutate !== "function") return;
  try {
    coordinator.mutate.call(coordinator, threadId, (current: unknown) => {
      if (!Array.isArray(current)) return current;
      return current.filter((item) => !isRecord(item) || item.id !== queuedSubmissionId);
    });
  } catch (error) {
    // The Host has already accepted the Turn. A Desktop cache cleanup failure
    // must not turn an acknowledged submission into a retryable failure.
    console.error("codexhost could not reconcile the submitted local follow-up", error);
  }
}

function installLocalQueueGate(target: Record<string, unknown>): (() => void) | null {
  const getTurnCoordinator = target.getTurnCoordinator as RendererMethod;
  const coordinator: unknown = getTurnCoordinator.call(target);
  const queue = isRecord(coordinator) ? coordinator.serverQueue : null;
  if (!isRecord(queue) || typeof queue.isEnabled !== "function") return null;
  // This is Desktop's plain queue backend object, not a RpcTarget. Do not shadow
  // inherited methods or guess at a different private API shape.
  const descriptor = Object.getOwnPropertyDescriptor(queue, "isEnabled");
  if (!descriptor?.writable) return null;
  const original = queue.isEnabled;
  const getConversation = target.getConversation as RendererMethod;
  const isEnabled = (...args: unknown[]): unknown => {
    const threadId = args[0];
    // Preserve native/unknown Threads, feature flags, and no-argument probes.
    // No selected-Agent state, ownership cache, or additional RPC is needed.
    if (
      typeof threadId === "string" &&
      isExternalConversation(getConversation.call(target, threadId), threadId)
    ) {
      return false;
    }
    return original.apply(queue, args);
  };
  queue.isEnabled = isEnabled;
  return () => {
    if (queue.isEnabled === isEnabled) Object.defineProperty(queue, "isEnabled", descriptor);
  };
}

/**
 * Desktop's owner auto-exec reads the local follow-up store, not Host
 * `thread/queue/*`. After an External Turn completes, start the Host head
 * item from the stream owner. Capture getStreamRole before steering wraps it.
 */
function installServerQueueDrain(target: Record<string, unknown>): (() => void) | null {
  if (typeof target.sendRequest !== "function") return null;
  const notifications = notificationTarget(target);
  if (!notifications) return null;
  const getConversation = target.getConversation as RendererMethod;
  const getTurnCoordinator = target.getTurnCoordinator as RendererMethod;
  const getStreamRole = target.getStreamRole as RendererMethod;
  const sendRequest = target.sendRequest as RendererMethod;
  const draining = new Set<string>();
  let disposed = false;

  const isExternalOwner = (threadId: string): boolean => {
    if (!isExternalConversation(getConversation.call(target, threadId), threadId)) return false;
    const role: unknown = getStreamRole.call(target, threadId);
    return !(isRecord(role) && role.role === "follower");
  };

  const isIdle = (threadId: string, coordinator: unknown): boolean => {
    const options = isRecord(coordinator) ? coordinator.options : null;
    const host = isRecord(options) ? options.submissionHost : null;
    if (
      isRecord(host) &&
      typeof host.getActiveTurnId === "function" &&
      typeof host.hasPendingTurnStart === "function"
    ) {
      return (
        host.getActiveTurnId.call(host, threadId) == null &&
        host.hasPendingTurnStart.call(host, threadId) !== true
      );
    }
    const conversation: unknown = getConversation.call(target, threadId);
    return (
      isRecord(conversation) &&
      isRecord(conversation.threadRuntimeStatus) &&
      conversation.threadRuntimeStatus.type === "idle"
    );
  };

  const queuedSubmissionId = (coordinator: unknown, threadId: string): string | null => {
    if (isRecord(coordinator) && typeof coordinator.readMessages === "function") {
      const messages: unknown = coordinator.readMessages.call(coordinator, threadId);
      if (Array.isArray(messages)) return firstQueuedItemId(messages);
    }
    const queue = isRecord(coordinator) ? coordinator.serverQueue : null;
    if (isRecord(queue) && typeof queue.read === "function") {
      return firstQueuedItemId(queue.read.call(queue, threadId));
    }
    return null;
  };

  const drain = (threadId: string): void => {
    if (disposed || draining.has(threadId) || !isExternalOwner(threadId)) return;
    const coordinator: unknown = getTurnCoordinator.call(target);
    if (!isIdle(threadId, coordinator)) return;
    const queuedSubmissionIdValue = queuedSubmissionId(coordinator, threadId);
    if (!queuedSubmissionIdValue) return;
    draining.add(threadId);
    Promise.resolve(
      sendRequest.call(target, "thread/queue/start", {
        threadId,
        queuedSubmissionId: queuedSubmissionIdValue,
      }),
    )
      .then(() => {
        // Host queue admission and Desktop's local queue cache are separate.
        // Remove only the item whose stable ID was acknowledged; preserve any
        // newer message the user entered while the request was in flight.
        removeQueuedItem(coordinator, threadId, queuedSubmissionIdValue);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Queued follow-up was not found")) return;
        console.error("codexhost could not start the queued follow-up", error);
      })
      .finally(() => {
        draining.delete(threadId);
      });
  };

  const onNotification = (notification: unknown): void => {
    if (disposed) return;
    const method =
      isRecord(notification) && typeof notification.method === "string"
        ? notification.method
        : null;
    const threadId = notificationThreadId(notification);
    if (!threadId) return;
    if (method === "turn/completed") {
      if (turnStatus(notification) === "interrupted") return;
      drain(threadId);
      return;
    }
    if (method === "thread/queue/changed") drain(threadId);
  };

  const unsubscribe = notifications.addNotificationCallback(
    ["turn/completed", "thread/queue/changed"],
    onNotification,
  );
  return () => {
    disposed = true;
    draining.clear();
    if (typeof unsubscribe === "function") unsubscribe();
  };
}

/**
 * Desktop 26.1016 overlay-owned External Threads drain through Host
 * `thread/queue/*`. Keep the local-queue gate only on Desktops that cannot
 * report stream ownership, where follower windows still need that fallback.
 */
export function installRendererExternalQueue(target: unknown): (() => void) | null {
  if (
    !isRecord(target) ||
    typeof target.getTurnCoordinator !== "function" ||
    typeof target.getConversation !== "function"
  ) {
    return null;
  }
  if (typeof target.getStreamRole === "function") return installServerQueueDrain(target);
  return installLocalQueueGate(target);
}
