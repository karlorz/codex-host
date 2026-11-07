import { createHash } from "node:crypto";

import { DelegationControlError } from "./delegation-types.js";
import type { DelegationThreadListResult, ThreadWatchListResult } from "./delegation-types.js";

/** Fixture parent Thread from the enrollment design; never an enrolled client's identity. */
export const FIXTURE_PARENT_THREAD_ID = "70afcd8a-2124-44e3-aa9d-9a7d4695f97c";

export const ENROLLMENT_VERBS = ["read", "watch", "send"] as const;
export type EnrollmentVerb = (typeof ENROLLMENT_VERBS)[number];

export const DEFAULT_ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ENROLLMENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_ENROLLMENT_CLIENT_ID = "grok-bot";

const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const VERB_SET: ReadonlySet<string> = new Set(ENROLLMENT_VERBS);

export interface EnrollmentAllowlistEntry {
  threadId: string;
  verbs: EnrollmentVerb[];
}

export interface EnrollmentRecord {
  schemaVersion: 1;
  enrollmentId: string;
  threadId: string;
  token: string;
  endpoint: string;
  clientId: string;
  executablePath: string;
  issuedAt: string;
  expiresAt: string;
  allowlist: EnrollmentAllowlistEntry[];
  allowlistDigest: string;
  revokedAt?: string;
}

export type EnrollmentFailureReason =
  | "denied"
  | "timeout"
  | "revoked"
  | "expired"
  | "clock_skew"
  | "allowlist_tamper"
  | "foreign_pid_environ"
  | "parent_env_file"
  | "impersonating_parent_thread"
  | "insecure_store_mode"
  | "missing_enroll_bootstrap"
  | "missing_store"
  | "non_loopback_endpoint";

export type EnrollmentRequestAction =
  | { type: "read"; threadId: string }
  | { type: "wait"; threadId: string }
  | { type: "watch"; threadId: string; notifyThreadId: string }
  | { type: "watches" }
  | { type: "send"; threadId: string }
  | { type: "cancel"; threadId: string }
  | { type: "list" }
  | { type: "delegate" }
  | { type: "harness" };

export function enrollmentError(
  code: "UNAUTHORIZED_TARGET" | "ENROLLMENT_DENIED" | "ENROLLMENT_INVALID",
  message: string,
  reason: EnrollmentFailureReason,
  details?: Record<string, unknown>,
): DelegationControlError {
  return new DelegationControlError(code, message, { reason, ...details });
}

export function parseEnrollmentClientId(value: string): string {
  if (!CLIENT_ID_PATTERN.test(value)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--client must be a lowercase id such as grok-bot",
    );
  }
  return value;
}

export function parseEnrollmentVerbs(values: readonly string[]): EnrollmentVerb[] {
  const verbs: EnrollmentVerb[] = [];
  for (const value of values) {
    if (!VERB_SET.has(value)) {
      throw new DelegationControlError("INVALID_ARGUMENT", `Enrollment verb '${value}' is invalid`);
    }
    if (!verbs.includes(value as EnrollmentVerb)) verbs.push(value as EnrollmentVerb);
  }
  return verbs;
}

/** `threadId:verb[,verb][;threadId:verb[,verb]...]`; omitted/empty means no extra Threads. */
export function parseAllowlistOption(value: string | undefined): EnrollmentAllowlistEntry[] {
  if (value === undefined || value === "") return [];
  const entries: EnrollmentAllowlistEntry[] = [];
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new DelegationControlError("INVALID_ARGUMENT", "--allow contains an empty entry");
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--allow entries must be threadId:verb[,verb]",
      );
    }
    const threadId = trimmed.slice(0, separator).trim();
    const verbs = parseEnrollmentVerbs(
      trimmed
        .slice(separator + 1)
        .split(",")
        .map((verb) => verb.trim())
        .filter(Boolean),
    );
    if (!threadId || verbs.length === 0) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--allow entries must be threadId:verb[,verb]",
      );
    }
    entries.push({ threadId, verbs });
  }
  return canonicalizeAllowlist(entries);
}

export function canonicalizeAllowlist(
  allowlist: readonly EnrollmentAllowlistEntry[],
): EnrollmentAllowlistEntry[] {
  const byThread = new Map<string, Set<EnrollmentVerb>>();
  for (const entry of allowlist) {
    const verbs = byThread.get(entry.threadId) ?? new Set<EnrollmentVerb>();
    for (const verb of parseEnrollmentVerbs(entry.verbs)) verbs.add(verb);
    byThread.set(entry.threadId, verbs);
  }
  return [...byThread.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([threadId, verbs]) => ({
      threadId,
      verbs: ENROLLMENT_VERBS.filter((verb) => verbs.has(verb)),
    }));
}

export function allowlistDigest(allowlist: readonly EnrollmentAllowlistEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeAllowlist(allowlist)))
    .digest("hex");
}

export function ownThreadAllowlist(threadId: string): EnrollmentAllowlistEntry {
  return { threadId, verbs: ["read", "watch", "send"] };
}

export function issuedAllowlist(
  threadId: string,
  requested: readonly EnrollmentAllowlistEntry[],
): EnrollmentAllowlistEntry[] {
  return canonicalizeAllowlist([ownThreadAllowlist(threadId), ...requested]);
}

export function assertLoopbackHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment endpoint is invalid",
      "non_loopback_endpoint",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment endpoint must be loopback HTTP",
      "non_loopback_endpoint",
    );
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment is only issued for this Mac's loopback Runtime",
      "non_loopback_endpoint",
    );
  }
  return url;
}

export function assertNotParentIdentity(threadId: string): void {
  if (threadId === FIXTURE_PARENT_THREAD_ID) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrolled clients cannot impersonate the parent Thread",
      "impersonating_parent_thread",
      { threadId },
    );
  }
}

export function verifyEnrollmentRecord(
  record: EnrollmentRecord,
  nowMs: number,
): asserts record is EnrollmentRecord {
  assertNotParentIdentity(record.threadId);
  assertLoopbackHttpUrl(record.endpoint);
  if (allowlistDigest(record.allowlist) !== record.allowlistDigest) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment allowlist no longer matches its consent digest",
      "allowlist_tamper",
      { enrollmentId: record.enrollmentId },
    );
  }
  if (record.revokedAt) {
    throw enrollmentError("ENROLLMENT_INVALID", "Enrollment has been revoked", "revoked", {
      enrollmentId: record.enrollmentId,
    });
  }
  const issuedAt = Date.parse(record.issuedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt < issuedAt) {
    throw enrollmentError("ENROLLMENT_INVALID", "Enrollment timestamps are invalid", "clock_skew", {
      enrollmentId: record.enrollmentId,
    });
  }
  if (nowMs + ENROLLMENT_CLOCK_SKEW_MS < issuedAt) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment clock skew is too large",
      "clock_skew",
      { enrollmentId: record.enrollmentId },
    );
  }
  if (nowMs > expiresAt) {
    throw enrollmentError("ENROLLMENT_INVALID", "Enrollment token has expired", "expired", {
      enrollmentId: record.enrollmentId,
    });
  }
}

function entryAllows(record: EnrollmentRecord, threadId: string, verb: EnrollmentVerb): boolean {
  return record.allowlist.some(
    (entry) => entry.threadId === threadId && entry.verbs.includes(verb),
  );
}

export function authorizeEnrollment(
  record: EnrollmentRecord,
  action: EnrollmentRequestAction,
  nowMs: number,
): void {
  verifyEnrollmentRecord(record, nowMs);
  switch (action.type) {
    case "list":
    case "watches":
      return;
    case "delegate":
    case "harness":
      throw enrollmentError(
        "UNAUTHORIZED_TARGET",
        "Enrolled clients cannot use this command",
        "denied",
        { action: action.type },
      );
    case "watch":
      if (action.notifyThreadId !== record.threadId) {
        throw enrollmentError(
          "ENROLLMENT_INVALID",
          "Watch notify Thread must be the enrolled client's own Thread",
          "impersonating_parent_thread",
          { notifyThreadId: action.notifyThreadId, threadId: record.threadId },
        );
      }
      if (!entryAllows(record, action.threadId, "watch")) {
        throw enrollmentError(
          "UNAUTHORIZED_TARGET",
          "Thread is not allowlisted for watch",
          "denied",
          { threadId: action.threadId, verb: "watch" },
        );
      }
      return;
    case "read":
    case "wait":
      if (!entryAllows(record, action.threadId, "read")) {
        throw enrollmentError(
          "UNAUTHORIZED_TARGET",
          "Thread is not allowlisted for read",
          "denied",
          { threadId: action.threadId, verb: "read" },
        );
      }
      return;
    case "send":
    case "cancel":
      if (!entryAllows(record, action.threadId, "send")) {
        throw enrollmentError(
          "UNAUTHORIZED_TARGET",
          "Thread is not allowlisted for send",
          "denied",
          { threadId: action.threadId, verb: "send" },
        );
      }
      return;
  }
}

export function filterEnrollmentThreadList(
  record: EnrollmentRecord,
  result: DelegationThreadListResult,
): DelegationThreadListResult {
  const allowed = new Set(record.allowlist.map((entry) => entry.threadId));
  allowed.add(record.threadId);
  return {
    threads: result.threads.filter((thread) => allowed.has(thread.threadId)),
    nextCursor: result.nextCursor,
  };
}

export function filterEnrollmentWatches(
  record: EnrollmentRecord,
  result: ThreadWatchListResult,
): ThreadWatchListResult {
  return {
    watches: result.watches.filter((watch) => watch.notifyThreadId === record.threadId),
  };
}

export function publicEnrollmentView(record: EnrollmentRecord): {
  enrollmentId: string;
  threadId: string;
  clientId: string;
  endpoint: string;
  expiresAt: string;
  allowlist: EnrollmentAllowlistEntry[];
} {
  return {
    enrollmentId: record.enrollmentId,
    threadId: record.threadId,
    clientId: record.clientId,
    endpoint: record.endpoint,
    expiresAt: record.expiresAt,
    allowlist: record.allowlist,
  };
}
