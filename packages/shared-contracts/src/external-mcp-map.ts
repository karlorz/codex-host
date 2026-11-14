import {
  EXTERNAL_MCP_TOOL_NAMES,
  type ExternalMcpDispatchRoute,
  type ExternalMcpToolName,
} from "./external-clients.js";

const DEFAULT_WATCH_MS = 29 * 60_000;
const MAX_TOOL_WAIT_MS = 60_000;
const DEFAULT_TOOL_WAIT_MS = 30_000;

export class ExternalMcpArgumentError extends Error {
  readonly code = "INVALID_ARGUMENT";
  constructor(message: string) {
    super(message);
    this.name = "ExternalMcpArgumentError";
  }
}

type Arguments = Record<string, unknown>;

function text(args: Arguments, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ExternalMcpArgumentError(`${name} must be a non-empty string`);
  }
  return value;
}

function threadId(args: Arguments): string {
  const value = text(args, "thread", false) ?? text(args, "threadId", true);
  const id = value as string;
  return id.startsWith("codex://threads/") ? id.slice("codex://threads/".length) : id;
}

function bounded(args: Arguments, name: string, fallback: number, maximum: number): number {
  const value = args[name] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ExternalMcpArgumentError(`${name} must be a non-negative integer`);
  }
  return Math.min(value as number, maximum);
}

function pick(args: Arguments, names: readonly string[]): Arguments {
  return Object.fromEntries(
    names.filter((name) => args[name] !== undefined).map((name) => [name, args[name]]),
  );
}

export function isExternalMcpToolName(name: string): name is ExternalMcpToolName {
  return (EXTERNAL_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Maps a shared-catalog tool call to the Host dispatch route body. */
export function mapExternalMcpToolCall(
  name: string,
  args: unknown,
): { route: ExternalMcpDispatchRoute; body: Record<string, unknown> } {
  if (!isExternalMcpToolName(name)) {
    throw new ExternalMcpArgumentError(`Unknown tool: ${name}`);
  }
  const input = (
    typeof args === "object" && args !== null && !Array.isArray(args) ? args : {}
  ) as Arguments;
  switch (name) {
    case "harness_list":
      return { route: "/v1/harness/list", body: {} };
    case "harness_inspect":
      return {
        route: "/v1/harness/inspect",
        body: pick(input, ["harnessId", "cwd", "refresh"]),
      };
    case "delegate_start":
      return {
        route: "/v1/delegate/start",
        body: {
          harnessId: text(input, "harnessId", true),
          task: text(input, "task", true),
          ...pick(input, ["taskName", "cwd", "requestId", "refs"]),
          ...(input.model !== undefined ? { model: { id: text(input, "model") } } : {}),
          ...(input.thinking !== undefined ? { thinkingOptionId: text(input, "thinking") } : {}),
          ...(input.parentThread !== undefined
            ? { parentThreadId: text(input, "parentThread") }
            : {}),
          ...(input.watch === true
            ? {
                watchTimeoutMs: bounded(
                  input,
                  "watchTimeoutMs",
                  DEFAULT_WATCH_MS,
                  Number.MAX_SAFE_INTEGER,
                ),
              }
            : {}),
        },
      };
    case "thread_read":
      return {
        route: "/v1/thread/read",
        body: {
          threadId: threadId(input),
          view: input.view ?? "result",
          ...pick(input, ["cursor", "limit"]),
        },
      };
    case "thread_wait":
      return {
        route: "/v1/thread/wait",
        body: {
          threadId: threadId(input),
          view: input.view ?? "result",
          timeoutMs: bounded(input, "timeoutMs", DEFAULT_TOOL_WAIT_MS, MAX_TOOL_WAIT_MS) || 1,
        },
      };
    case "thread_list":
      return {
        route: "/v1/thread/list",
        body: {
          ...pick(input, ["cwd", "client", "ref", "cursor"]),
          ...(input.parent !== undefined ? { parentThreadId: text(input, "parent") } : {}),
          limit: bounded(input, "limit", 25, 100) || 25,
          sort: input.sort ?? "created-desc",
        },
      };
    case "thread_send":
      return {
        route: "/v1/thread/send",
        body: { threadId: threadId(input), message: text(input, "message", true) },
      };
    case "thread_cancel":
      return { route: "/v1/thread/cancel", body: { threadId: threadId(input) } };
    case "thread_watch":
      return {
        route: "/v1/thread/watch",
        body: {
          threadId: threadId(input),
          timeoutMs: bounded(input, "timeoutMs", DEFAULT_WATCH_MS, Number.MAX_SAFE_INTEGER) || 1,
        },
      };
    case "thread_watches":
      return { route: "/v1/thread/watches", body: {} };
    case "events_poll":
      return { route: "/v1/events/poll", body: pick(input, ["after", "timeoutMs", "limit"]) };
  }
}
