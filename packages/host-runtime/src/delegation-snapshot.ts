import { createHash } from "node:crypto";

import type { JsonObject } from "@codexhost/protocol-core";
import type { RoutedHarnessId } from "@codexhost/protocol-core";

import {
  DelegationControlError,
  isTerminalDelegationStatus,
  type DelegationMessage,
  type DelegationThreadResult,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type DelegationTurnError,
  type ThreadReadInput,
} from "./delegation-types.js";

const CURSOR_PREFIX = "codexhost:thread-messages:v1:";
const DEFAULT_MESSAGE_LIMIT = 25;
const MAX_MESSAGE_LIMIT = 100;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function textFromUserItem(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function threadStatus(value: unknown, running: boolean): DelegationThreadStatus {
  if (running) return "running";
  if (isRecord(value)) {
    if (value.type === "active") return "running";
  }
  return "completed";
}

function turnStatus(value: unknown): DelegationThreadStatus {
  if (value === "inProgress" || value === "running") return "running";
  if (value === "failed") return "failed";
  if (value === "interrupted" || value === "cancelled") return "interrupted";
  return "completed";
}

function turnErrorPayload(turn: JsonObject | null): DelegationTurnError | undefined {
  if (!isRecord(turn?.error)) return undefined;
  const error = turn.error;
  const message = typeof error.message === "string" && error.message ? error.message : undefined;
  const diagnostic =
    typeof error.diagnostic === "string" && error.diagnostic
      ? error.diagnostic
      : typeof error.additionalDetails === "string" && error.additionalDetails
        ? error.additionalDetails
        : undefined;
  const code = typeof error.code === "string" && error.code ? error.code : undefined;
  if (!message && !diagnostic) return undefined;
  return {
    message: message ?? diagnostic ?? "Turn failed",
    ...(code ? { code } : {}),
    ...(diagnostic && diagnostic !== message ? { diagnostic } : {}),
  };
}

function agentMessagesForTurn(
  visible: readonly DelegationMessage[],
  turnId: string | null,
): DelegationMessage[] {
  return turnId
    ? visible.filter((message) => message.turnId === turnId && message.role === "agent")
    : [];
}

function lastCompletedForRunningTurns(
  turns: readonly JsonObject[],
  latestTurnId: string | null,
  visible: readonly DelegationMessage[],
): DelegationThreadSnapshot["lastCompleted"] {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!isRecord(turn)) continue;
    const turnId = stringValue(turn.id);
    if (!turnId || turnId === latestTurnId) continue;
    const status = turnStatus(turn.status);
    if (!isTerminalDelegationStatus(status)) continue;
    return {
      turnId,
      status,
      result: resultForTurn(turn, agentMessagesForTurn(visible, turnId), false),
    };
  }
  return undefined;
}

function resultForTurn(
  turn: JsonObject | null,
  messages: readonly DelegationMessage[],
  running: boolean,
): DelegationThreadResult {
  const final = messages
    .filter((message) => message.phase === "final" && message.text.trim())
    .at(-1);
  const error = turnErrorPayload(turn);
  if (running)
    return { availability: "pending", ...(error ? { error, message: error.message } : {}) };
  if (final) return { availability: "available", text: final.text };
  return {
    availability: "unavailable",
    ...(error ? { message: error.message, error } : {}),
  };
}

function allVisibleMessages(turns: readonly JsonObject[]): DelegationMessage[] {
  const messages: DelegationMessage[] = [];
  for (const turn of turns) {
    const turnId = stringValue(turn.id);
    if (!turnId || !Array.isArray(turn.items)) continue;
    const agentItems = turn.items.filter(
      (item): item is JsonObject => isRecord(item) && item.type === "agentMessage",
    );
    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      const id = stringValue(item.id);
      if (!id) continue;
      if (item.type === "userMessage") {
        const text = textFromUserItem(item);
        if (text) messages.push({ id, turnId, role: "user", text });
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
        const itemIndex = agentItems.indexOf(item);
        const phase =
          item.phase === "commentary" || item.phase === "final"
            ? item.phase
            : turn.status === "inProgress" || itemIndex < agentItems.length - 1
              ? "commentary"
              : "final";
        messages.push({ id, turnId, role: "agent", phase, text: item.text });
      }
    }
  }
  return messages;
}

function cursorFingerprint(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

function encodeCursor(threadId: string, offset: number): string {
  const payload = JSON.stringify({ version: 1, fingerprint: cursorFingerprint(threadId), offset });
  return `${CURSOR_PREFIX}${Buffer.from(payload).toString("base64url")}`;
}

function decodeCursor(threadId: string, cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Message cursor is invalid");
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.fingerprint !== cursorFingerprint(threadId) ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return value.offset as number;
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Message cursor is invalid");
  }
}

export function validateReadOptions(input: ThreadReadInput): Required<
  Pick<ThreadReadInput, "view">
> & {
  cursor?: string;
  limit: number;
} {
  if (input.view !== "result" && input.view !== "messages") {
    throw new DelegationControlError("INVALID_ARGUMENT", "View must be 'result' or 'messages'");
  }
  if (input.view === "result" && (input.cursor !== undefined || input.limit !== undefined)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--cursor and --limit require --view messages",
    );
  }
  const limit = input.limit ?? DEFAULT_MESSAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_MESSAGE_LIMIT) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Message limit must be between 1 and ${MAX_MESSAGE_LIMIT}`,
    );
  }
  return { view: input.view, ...(input.cursor ? { cursor: input.cursor } : {}), limit };
}

export function projectDelegationThreadSnapshot(input: {
  threadId: string;
  harnessId: RoutedHarnessId;
  thread: JsonObject;
  turns: readonly JsonObject[];
  running: boolean;
  view: "result" | "messages";
  cursor?: string;
  limit?: number;
}): DelegationThreadSnapshot {
  const options = validateReadOptions({
    threadId: input.threadId,
    view: input.view,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const visible = allVisibleMessages(input.turns);
  const latestTurn = (input.turns.at(-1) as JsonObject | undefined) ?? null;
  const latestTurnId = latestTurn ? stringValue(latestTurn.id) : null;
  const latestTurnStatus = latestTurn ? turnStatus(latestTurn.status) : null;
  const status = input.running
    ? "running"
    : latestTurnStatus === "failed" || latestTurnStatus === "interrupted"
      ? latestTurnStatus
      : threadStatus(input.thread.status, input.running);
  const latestTurnMessages = agentMessagesForTurn(visible, latestTurnId);
  const progress = latestTurnMessages
    .filter((message) => message.phase !== "final" && message.text.trim())
    .map(({ id, turnId, text }) => ({ id, turnId, text }));
  const result = resultForTurn(latestTurn, latestTurnMessages, input.running);
  const lastCompleted =
    input.running && input.turns.length >= 2
      ? lastCompletedForRunningTurns(input.turns, latestTurnId, visible)
      : undefined;

  const offset =
    options.view === "messages" ? decodeCursor(input.threadId, options.cursor) : visible.length;
  // Keep cursor offsets in the original message sequence, including whitespace,
  // so cursors issued before whitespace filtering remain valid.
  const page: DelegationMessage[] | undefined = options.view === "messages" ? [] : undefined;
  let nextOffset = offset;
  if (page) {
    while (nextOffset < visible.length && page.length < options.limit) {
      const message = visible[nextOffset++];
      if (message?.text.trim()) page.push(message);
    }
  }
  return {
    threadId: input.threadId,
    harnessId: input.harnessId,
    status,
    turn:
      latestTurnId && latestTurnStatus ? { turnId: latestTurnId, status: latestTurnStatus } : null,
    ...(input.turns.length > 0 ? { turnIndex: input.turns.length } : {}),
    progress,
    result,
    ...(lastCompleted ? { lastCompleted } : {}),
    ...(page
      ? {
          messages: page,
          hasMore: visible.slice(nextOffset).some((message) => message.text.trim()),
        }
      : {}),
    nextCursor: encodeCursor(input.threadId, nextOffset),
  };
}
