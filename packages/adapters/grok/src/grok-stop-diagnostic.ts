import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { HarnessError } from "@codexhost/harness-adapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function collectText(value: unknown, into: string[], depth = 0): void {
  if (depth > 4) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length > 0 && !into.includes(text)) into.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, into, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of [
    "message",
    "error",
    "reason",
    "detail",
    "details",
    "diagnostic",
    "cause",
    "err",
  ]) {
    if (Object.hasOwn(value, key)) collectText(value[key], into, depth + 1);
  }
}

/** Pull operator-readable detail out of ACP `_meta` or native history metadata. */
export function grokStopDetail(source: unknown, stopReason: string): string | undefined {
  const parts: string[] = [];
  collectText(source, parts);
  const useful = parts.filter(
    (part) => part !== stopReason && part.toLowerCase() !== "error" && part.length > 1,
  );
  return useful.length > 0 ? useful.join(": ") : undefined;
}

export function grokTurnStopError(stopReason: string, source?: unknown): HarnessError {
  const detail = grokStopDetail(source, stopReason);
  const diagnostic = source !== undefined && source !== null ? JSON.stringify(source) : undefined;
  return {
    code: "nativeFailure",
    message: detail
      ? `Grok stopped the Turn: ${stopReason}: ${detail}`
      : `Grok stopped the Turn: ${stopReason}`,
    retryable: stopReason === "max_tokens" || stopReason === "max_turn_requests",
    ...(diagnostic && diagnostic !== "{}" && diagnostic !== "null" ? { diagnostic } : {}),
  };
}

export function grokPromptStopError(response: PromptResponse): HarnessError {
  return grokTurnStopError(response.stopReason, response._meta ?? undefined);
}
