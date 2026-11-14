export const REALTIME_CALL_METHOD = "codexhost/realtime/call";

/**
 * Native voice headers the Host may forward to the configured gateway. Anything
 * else — Desktop OAuth, ChatGPT account identity and cookies — is dropped at the
 * Renderer bridge and again at the Host before the outbound request.
 */
export const REALTIME_CALL_FORWARDED_HEADERS: readonly string[] = [
  "openai-alpha",
  "thread-id",
  "session-id",
  "originator",
  "x-codex-turn-metadata",
];
const FORWARDED_HEADERS = new Set(REALTIME_CALL_FORWARDED_HEADERS);

/** Keeps only allowlisted headers with a usable value; all other names are dropped. */
export function filterRealtimeCallHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (FORWARDED_HEADERS.has(key) && value.length > 0 && value.length <= 4096) result[key] = value;
  }
  return result;
}

/** Gateway-created realtime call identity. Codex `rtc_` remains valid; configured
 * CPA also forwards `/calls/<id>` values without that prefix. */
export const REALTIME_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function isRealtimeCallId(value: unknown): value is string {
  return typeof value === "string" && REALTIME_CALL_ID_PATTERN.test(value);
}

/**
 * Reads the created call identity from a gateway `Location` response header: a bare
 * identity, or the trailing segment after `/calls/` or `/live/`, ignoring any query
 * string or fragment. Host create uses {@link isRealtimeCallId} on this value.
 */
export function realtimeCallIdFromLocation(location: string): string | undefined {
  const path = location.split(/[?#]/u)[0] ?? "";
  if (/^[A-Za-z0-9_-]{1,128}$/u.test(path)) return path;
  return /\/(?:calls|live)\/([A-Za-z0-9_-]{1,128})$/u.exec(path)?.[1];
}
