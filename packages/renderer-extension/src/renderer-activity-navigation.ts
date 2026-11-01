import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import type { BackgroundActivity } from "@codexhost/shared-contracts";
import type { QuestionContext } from "./renderer-questions.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Desktop 26.1027's conversation surface owns the Host-scoped child-panel callback. */
export function openRendererActivityChild(owner: QuestionContext, child: BackgroundActivity): void {
  if (!owner.composer.isConnected || child.kind !== "subagent" || !child.threadId)
    throw Error("Native child conversation is unavailable");
  const callbacks = new Set<(child: unknown) => unknown>();
  const seen = new Set<object>();
  const anchors = [owner.composer, ...owner.composer.querySelectorAll("[contenteditable]")];
  for (const anchor of anchors) {
    const keys = Object.getOwnPropertyNames(anchor).filter((key) =>
      key.startsWith("__reactFiber$"),
    );
    const key = keys[0];
    if (keys.length !== 1 || !key) continue;
    const first = Object.getOwnPropertyDescriptor(anchor, key)?.value;
    for (const fiber of committedReactAncestors(first)) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      if (!record(props) || typeof props.onOpenBackgroundAgent !== "function") continue;
      if (typeof props.hostId !== "string" || typeof props.conversationId !== "string") continue;
      if (props.hostId !== owner.hostId || props.conversationId !== owner.threadId)
        throw Error("Native child navigation belongs to another chat or Host");
      callbacks.add(props.onOpenBackgroundAgent as (child: unknown) => unknown);
    }
  }
  const callback = callbacks.values().next().value;
  if (callbacks.size !== 1 || !callback)
    throw Error("Native child navigation is unavailable or ambiguous");
  // Host materializes genuine children as read-only. The native callback selects
  // the Subagents panel and verifies descendant membership before displaying one.
  callback({ conversationId: child.threadId, displayName: child.label, canInteract: false });
}
