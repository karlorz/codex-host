import type { GrokTransportEvent } from "./acp-transport.js";

export function grokPromptIndex(event: GrokTransportEvent): number | null {
  const value = event.metadata?.promptIndex ?? event.metadata?.prompt_index;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function grokHiddenInput(
  event: Extract<GrokTransportEvent, { type: "user.text" }>,
): boolean {
  return event.metadata?.hideFromScrollback === true || /^\s*<system-reminder>/u.test(event.text);
}

export function grokHostTurn(event: GrokTransportEvent): boolean {
  return event.metadata?.hostTurn === true || event.metadata?.host_turn === true;
}

const GROK_SIBLING_TERMINAL = /^(?:subagent-completed-|task-completed-)/u;

export function grokSiblingTerminalKey(key: string): boolean {
  return GROK_SIBLING_TERMINAL.test(key);
}

/** Loop/task terminals that must not close a user Host Turn. */
export function grokForeignBackgroundEvent(event: GrokTransportEvent): boolean {
  if (event.type === "turn.completed") return grokSiblingTerminalKey(event.nativeTurnKey);
  if (event.type === "user.text") {
    return (
      grokHiddenInput(event) && /background subagent completed|Background task/iu.test(event.text)
    );
  }
  const promptId = event.metadata?.promptId ?? event.metadata?.prompt_id;
  return typeof promptId === "string" && grokSiblingTerminalKey(promptId);
}

export function grokBackgroundOwnedTurn(input: {
  turnId: string;
  backgroundPromptIndex?: number;
}): boolean {
  return input.turnId.startsWith("grok-autonomous-") || input.backgroundPromptIndex !== undefined;
}

export function selectGrokSettledTurn<
  T extends {
    nativeTurnRef: { nativeTurnKey: string };
    checkpoint?: { checkpointId: string } | null;
  },
>(created: readonly T[], expectedKey?: string, backgroundPromptIndex?: number): T | undefined {
  if (expectedKey) {
    const matched = created.filter((turn) => turn.nativeTurnRef.nativeTurnKey === expectedKey);
    return matched.length === 1 ? matched[0] : undefined;
  }
  if (backgroundPromptIndex !== undefined) {
    const matched = created.filter(
      (turn) => Number(turn.checkpoint?.checkpointId) === backgroundPromptIndex,
    );
    return matched.length === 1 ? matched[0] : undefined;
  }
  return created.length === 1 ? created[0] : undefined;
}

export interface GrokHistoryGroup {
  user?: Extract<GrokTransportEvent, { type: "user.text" }>;
  terminal: Extract<GrokTransportEvent, { type: "turn.completed" }>;
  terminalIndex: number;
  userIndex?: number;
  disposition: "durable" | "ephemeral" | "reused";
}

export class GrokNativeIdentityReuseError extends Error {
  constructor(key: string) {
    super(`Grok Native terminal identity reused by a new prompt: ${key}`);
  }
}

function hasUsage(usage: unknown): boolean {
  if (!usage || typeof usage !== "object") return false;
  return Object.entries(usage).some(
    ([key, value]) =>
      /^(?:inputTokens|outputTokens|totalTokens|reasoningTokens|thoughtTokens|cachedReadTokens|cacheCreationTokens|costUsdTicks)$/u.test(
        key,
      ) &&
      typeof value === "number" &&
      value > 0,
  );
}

/** Classify native prompt boundaries, never terminal-name prefixes or reminder wording. */
export function classifyGrokHistory(events: readonly GrokTransportEvent[]): GrokHistoryGroup[] {
  const groups: GrokHistoryGroup[] = [];
  const retained = new Map<string, number>();
  let user: GrokHistoryGroup["user"];
  let userIndex: number | undefined;
  let evidence = false;
  let goalPresent = false;
  let goalWorker = false;
  let promptIndex = 0;
  for (const [terminalIndex, event] of events.entries()) {
    if (event.type === "goal.changed") goalPresent = event.update !== null;
    if (event.type === "rewind.marker") {
      for (const [key, index] of retained)
        if (index >= event.targetPromptIndex) retained.delete(key);
      promptIndex = event.targetPromptIndex;
      user = undefined;
      userIndex = undefined;
      evidence = false;
    } else if (event.type === "user.text") {
      if (
        !user ||
        (grokHiddenInput(user) && grokPromptIndex(user) === null && !grokHiddenInput(event))
      ) {
        user = event;
        userIndex = terminalIndex;
        evidence = false;
        goalWorker = goalPresent;
      }
    } else if (event.type === "agent.text" || event.type === "agent.thought") {
      evidence ||= event.text.length > 0;
    } else if (event.type === "tool.call") evidence = true;
    else if (event.type === "turn.completed") {
      const hidden = user && grokHiddenInput(user);
      const host = user ? grokHostTurn(user) : false;
      const index = user ? (grokPromptIndex(user) ?? promptIndex) : promptIndex;
      // A native goal can be cancelled before its first inference or Item.
      const executed =
        evidence || hasUsage(event.usage) || (goalWorker && event.stopReason === "cancelled");
      const eligible = !host && (!hidden || (user && grokPromptIndex(user) !== null && executed));
      const reused = retained.has(event.nativeTurnKey);
      const disposition =
        !eligible || (reused && (!user || (hidden && !executed)))
          ? "ephemeral"
          : reused
            ? "reused"
            : "durable";
      groups.push({
        ...(user ? { user } : {}),
        ...(userIndex !== undefined ? { userIndex } : {}),
        terminal: event,
        terminalIndex,
        disposition,
      });
      if (disposition === "durable") retained.set(event.nativeTurnKey, index);
      if (user && !host) promptIndex = index + 1;
      user = undefined;
      userIndex = undefined;
      evidence = false;
      goalWorker = false;
    }
  }
  return groups;
}
