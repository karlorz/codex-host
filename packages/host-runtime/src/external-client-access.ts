import { DelegationControlError } from "./delegation-types.js";
import type { ExternalClientCall, ExternalClientRouter } from "./external-client-server.js";
import type { ExternalClientRecord, ExternalClientRegistry } from "./external-clients.js";
import { canonicalizeWorkspace, workspaceAllowed } from "./external-client-workspace.js";
import { originClientName } from "./external-client-origin.js";

function denied(message: string, details?: Record<string, unknown>): never {
  throw new DelegationControlError("UNAUTHORIZED_TARGET", message, details);
}

async function resolvedWorkspace(cwd: unknown): Promise<string | undefined> {
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  return canonicalizeWorkspace(cwd);
}

async function assertWorkspace(
  record: ExternalClientRecord,
  cwd: string | undefined,
  message: string,
): Promise<void> {
  if (record.access === "all-threads") return;
  if (!cwd || !workspaceAllowed(record.workspaces, cwd)) {
    denied(message, { access: record.access });
  }
}

async function parentWorkspace(
  parent: unknown,
  workspaceOf: (threadId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (typeof parent !== "string" || !parent) return undefined;
  if (originClientName(parent)) return undefined;
  const cwd = await workspaceOf(parent);
  return cwd ? canonicalizeWorkspace(cwd) : undefined;
}

async function threadWorkspace(
  threadId: unknown,
  workspaceOf: (threadId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (typeof threadId !== "string" || !threadId) return undefined;
  const cwd = await workspaceOf(threadId);
  return cwd ? canonicalizeWorkspace(cwd) : undefined;
}

async function enforceRequest(
  record: ExternalClientRecord,
  route: string,
  body: Record<string, unknown>,
  workspaceOf: (threadId: string) => Promise<string | undefined>,
): Promise<void> {
  if (record.access === "all-threads") return;
  if (route === "/v1/harness/list" || route === "/v1/thread/watches") return;
  if (route === "/v1/harness/inspect") {
    const cwd = await resolvedWorkspace(body.cwd);
    if (body.cwd !== undefined)
      await assertWorkspace(record, cwd, "This client cannot inspect that workspace");
    return;
  }
  if (route === "/v1/delegate/start") {
    const cwd = await resolvedWorkspace(body.cwd);
    await assertWorkspace(record, cwd, "This client cannot start work in that workspace");
    const parent = await parentWorkspace(body.parentThreadId, workspaceOf);
    if (typeof body.parentThreadId === "string" && !originClientName(body.parentThreadId)) {
      await assertWorkspace(record, parent, "This client cannot use that parent Thread");
    }
    return;
  }
  if (route === "/v1/thread/list") {
    if (body.cwd !== undefined) {
      await assertWorkspace(
        record,
        await resolvedWorkspace(body.cwd),
        "This client cannot list that workspace",
      );
    }
    if (typeof body.parentThreadId === "string" && !originClientName(body.parentThreadId)) {
      await assertWorkspace(
        record,
        await parentWorkspace(body.parentThreadId, workspaceOf),
        "This client cannot list that parent Thread",
      );
    }
    return;
  }
  if (
    route === "/v1/thread/read" ||
    route === "/v1/thread/wait" ||
    route === "/v1/thread/send" ||
    route === "/v1/thread/cancel" ||
    route === "/v1/thread/watch"
  ) {
    await assertWorkspace(
      record,
      await threadWorkspace(body.threadId, workspaceOf),
      "This client cannot use that Thread",
    );
  }
}

function threadIdOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "threadId" in value) {
    const threadId = (value as { threadId?: unknown }).threadId;
    return typeof threadId === "string" ? threadId : undefined;
  }
  return undefined;
}

async function filterList(
  record: ExternalClientRecord,
  value: unknown,
  workspaceOf: (threadId: string) => Promise<string | undefined>,
): Promise<unknown> {
  if (record.access === "all-threads") return value;
  if (typeof value !== "object" || value === null || !("threads" in value)) return value;
  const page = value as { threads: unknown[]; nextCursor?: unknown };
  const kept: unknown[] = [];
  for (const thread of page.threads) {
    const cwd =
      typeof thread === "object" && thread !== null && "cwd" in thread
        ? typeof (thread as { cwd?: unknown }).cwd === "string"
          ? await canonicalizeWorkspace((thread as { cwd: string }).cwd).catch(() => undefined)
          : undefined
        : await threadWorkspace(threadIdOf(thread), workspaceOf);
    if (workspaceAllowed(record.workspaces, cwd)) kept.push(thread);
  }
  return { ...page, threads: kept };
}

async function filterWatches(
  record: ExternalClientRecord,
  value: unknown,
  workspaceOf: (threadId: string) => Promise<string | undefined>,
): Promise<unknown> {
  if (record.access === "all-threads") return value;
  if (typeof value !== "object" || value === null || !("watches" in value)) return value;
  const page = value as { watches: unknown[] };
  const kept: unknown[] = [];
  for (const watch of page.watches) {
    const cwd = await threadWorkspace(threadIdOf(watch), workspaceOf);
    if (workspaceAllowed(record.workspaces, cwd)) kept.push(watch);
  }
  return { ...page, watches: kept };
}

async function filterEvents(
  record: ExternalClientRecord,
  value: unknown,
  workspaceOf: (threadId: string) => Promise<string | undefined>,
): Promise<unknown> {
  if (record.access === "all-threads") return value;
  if (typeof value !== "object" || value === null || !("events" in value)) return value;
  const page = value as { events: unknown[]; cursor?: unknown };
  const kept: unknown[] = [];
  for (const event of page.events) {
    const cwd = await threadWorkspace(threadIdOf(event), workspaceOf);
    if (workspaceAllowed(record.workspaces, cwd)) kept.push(event);
  }
  return { ...page, events: kept };
}

/** Enforces per-client All Threads / Selected workspaces on every dispatch route. */
export function withExternalClientAccess(
  route: ExternalClientRouter,
  input: {
    clients: ExternalClientRegistry;
    workspaceOf?: (threadId: string) => Promise<string | undefined>;
  },
): ExternalClientRouter {
  const workspaceOf = input.workspaceOf ?? (async () => undefined);
  return async (call: ExternalClientCall, path: string, body: Record<string, unknown>) => {
    const record = await input.clients.record(call.client);
    if (!record) denied("This client is no longer registered");
    await enforceRequest(record, path, body, workspaceOf);
    const result = await route(call, path, body);
    const latest = await input.clients.record(call.client);
    if (!latest) denied("This client is no longer registered");
    await enforceRequest(latest, path, body, workspaceOf);
    if (path === "/v1/thread/list") return filterList(latest, result, workspaceOf);
    if (path === "/v1/thread/watches") return filterWatches(latest, result, workspaceOf);
    if (path === "/v1/events/poll") return filterEvents(latest, result, workspaceOf);
    return result;
  };
}
