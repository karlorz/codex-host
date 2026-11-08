import type { RoutedHarnessId } from "@codexhost/protocol-core";
import type {
  HarnessInspection,
  HarnessModelRef,
  HarnessSessionState,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";

export const DELEGATION_RUNTIME_ENDPOINT_ENV = "CODEXHOST_RUNTIME_ENDPOINT";
export const DELEGATION_RUNTIME_TOKEN_ENV = "CODEXHOST_RUNTIME_TOKEN";
export const DELEGATION_CLI_PATH_ENV = "CODEXHOST_CLI_PATH";
/** Node for the Launcher's delegation CLI in npm installations; read only by the Launcher. */
export const DELEGATION_CLI_NODE_PATH_ENV = "CODEXHOST_CLI_NODE_PATH";
export const DELEGATION_THREAD_ID_ENV = "CODEXHOST_THREAD_ID";
/**
 * Native Codex shares one app-server across Threads, so the Host cannot set
 * CODEXHOST_THREAD_ID per Thread; Codex exports the calling Thread here instead.
 */
export const NATIVE_CODEX_THREAD_ID_ENV = "CODEX_THREAD_ID";
/** Default watch expiry; callers adjust it with --timeout-ms. */
export const DEFAULT_WATCH_TIMEOUT_MS = 29 * 60_000;
/** Quiet period before a `completed` watch fires, so a follow-up Turn can start. */
export const DEFAULT_WATCH_QUIET_MS = 8_000;

export type DelegationThreadStatus =
  "creating" | "running" | "completed" | "failed" | "interrupted";

export type DelegationResultAvailability = "pending" | "available" | "unavailable";

export interface DelegationMessage {
  id: string;
  turnId: string;
  role: "user" | "agent";
  text: string;
  phase?: "commentary" | "final";
}

export interface DelegationProgress {
  id: string;
  turnId: string;
  text: string;
}

export interface DelegationThreadResult {
  availability: DelegationResultAvailability;
  text?: string;
  message?: string;
  error?: DelegationTurnError;
}

export interface DelegationThreadSnapshot {
  hostId?: string;
  threadId: string;
  harnessId: RoutedHarnessId;
  status: DelegationThreadStatus;
  turn: { turnId: string; status: DelegationThreadStatus } | null;
  progress: DelegationProgress[];
  result: DelegationThreadResult;
  /** 1-based index of `turn` among visible Turns. */
  turnIndex?: number;
  /**
   * Latest terminal Turn that is not the current Turn. Present in compact and
   * JSON when a newer Turn is running so its result is not hidden.
   */
  lastCompleted?: {
    turnId: string;
    status: DelegationThreadStatus;
    result: DelegationThreadResult;
  };
  messages?: DelegationMessage[];
  hasMore?: boolean;
  nextCursor: string | null;
}

export interface DelegationTurnError {
  message: string;
  code?: string;
  diagnostic?: string;
}

export interface DelegationStartInput {
  harnessId: RoutedHarnessId;
  task: string;
  /** Short display name; the full task remains the initial message. */
  taskName?: string;
  cwd?: string;
  parentThreadId?: string;
  requestId?: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  /**
   * When true, an unavailable requested Model/Thinking is replaced with the
   * Harness native default instead of rejected. Off by default.
   */
  fallbackDefault?: boolean;
}

export interface HarnessInspectInput {
  harnessId: RoutedHarnessId;
  cwd?: string;
  refresh?: boolean;
}

export interface HarnessInspectResult {
  harnessId: RoutedHarnessId;
  inspection: HarnessInspection;
}

export interface HarnessListResult {
  harnesses: RoutedHarnessId[];
}

export type DelegationModelResolutionDecision =
  "requested" | "harness-default" | "fallback-default";

export interface DelegationConfigurationResult {
  requested?: { model?: HarnessModelRef; thinkingOptionId?: HarnessThinkingOptionId };
  effective?: Pick<
    HarnessSessionState,
    "effectiveModel" | "resolvedModelLabel" | "effectiveThinkingOptionId"
  >;
  modelResolution?: {
    decision: DelegationModelResolutionDecision;
    fallbackDefault: boolean;
  };
}

export interface DelegationStartResult {
  delegationId: string;
  threadId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  deepLink: string;
  status: DelegationThreadStatus;
  cwd?: string;
  parentThreadId?: string;
  configuration?: DelegationConfigurationResult;
  /** Present only when the caller asked `delegate start` to also watch the child. */
  watch?: ThreadWatchResult | { state: "notRegistered"; reason: string };
  next: { read: string; wait: string };
}

export interface ThreadSendInput {
  threadId: string;
  message: string;
}

export interface ThreadSendResult {
  threadId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  status: "running";
  next: { read: string; wait: string };
}

export interface ThreadCancelInput {
  threadId: string;
}

export interface ThreadCancelResult {
  threadId: string;
  turnId: string | null;
  harnessId: RoutedHarnessId;
  cancelled: boolean;
}

export interface ThreadReadInput {
  /** Internal caller context from the CLI; not forwarded to another Host. */
  callerThreadId?: string;
  /** Explicit Desktop Host identity; never inferred from the Thread ID. */
  hostId?: string;
  threadId: string;
  view: "result" | "messages";
  cursor?: string;
  limit?: number;
}

export interface ThreadWaitInput extends ThreadReadInput {
  timeoutMs: number;
}

export interface ThreadListInput {
  cwd?: string;
  parentThreadId?: string;
  limit: number;
  cursor?: string;
  sort:
    | "created-asc"
    | "created-desc"
    | "updated-asc"
    | "updated-desc"
    | "recency-asc"
    | "recency-desc";
}

export interface DelegationThreadListItem {
  threadId: string;
  harnessId: RoutedHarnessId;
  deepLink: string;
  status: DelegationThreadStatus;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Set by native rows; recency-* sorts order by it, falling back to updatedAt. */
  recencyAt?: string;
}

export interface DelegationThreadListResult {
  threads: DelegationThreadListItem[];
  nextCursor: string | null;
}

export interface ThreadWatchInput {
  /** Thread observed until it stops. */
  threadId: string;
  /** Thread that receives the single notification. */
  notifyThreadId: string;
  timeoutMs: number;
}

export type ThreadWatchOutcome =
  | "completed"
  | "failed"
  | "interrupted"
  /** The Thread was still running when the watch expired. */
  | "timedOut"
  /** Reads kept failing, so the state of the Thread is unknown. */
  | "unreadable"
  | "notFound";

export interface ThreadWatchResult {
  threadId: string;
  notifyThreadId: string;
  /** `alreadyTerminal` means no watch was registered and no notification will be sent. */
  state: "watching" | "alreadyTerminal";
  status: DelegationThreadStatus;
  timeoutMs: number;
}

export interface ThreadWatchEntry {
  threadId: string;
  notifyThreadId: string;
  state: "watching" | "pendingDelivery" | "undeliverable";
  outcome?: ThreadWatchOutcome;
  /** Turn that reached the terminal outcome, when the Thread reported one. */
  turnId?: string;
  /** 1-based index of that Turn, when the snapshot reported one. */
  turnIndex?: number;
  /** Status of that Turn, distinct from the Thread-level outcome. */
  turnStatus?: DelegationThreadStatus;
  /** Present for `undeliverable`. */
  reason?: string;
  registeredAt: string;
}

export interface ThreadWatchListResult {
  watches: ThreadWatchEntry[];
}

/**
 * Opt-in, one-shot notifications when a watched Thread stops. Separate from
 * DelegationControlApi so Host sessions keep implementing only the per-Thread
 * operations.
 */
export interface DelegationWatchApi {
  watch(input: ThreadWatchInput): Promise<ThreadWatchResult>;
  watches(): Promise<ThreadWatchListResult>;
}

export interface DelegationControlApi {
  listHarnesses(): Promise<HarnessListResult>;
  inspect(input: HarnessInspectInput): Promise<HarnessInspectResult>;
  start(input: DelegationStartInput): Promise<DelegationStartResult>;
  send(input: ThreadSendInput): Promise<ThreadSendResult>;
  cancel(input: ThreadCancelInput): Promise<ThreadCancelResult>;
  read(input: ThreadReadInput): Promise<DelegationThreadSnapshot>;
  wait(input: ThreadWaitInput): Promise<DelegationThreadSnapshot & { timedOut: boolean }>;
  list(input: ThreadListInput): Promise<DelegationThreadListResult>;
}

export interface DelegationControlRegistration extends DelegationControlApi {
  executionHostId?(threadId: string): string | undefined;
  canHandleStart(input: DelegationStartInput): boolean | Promise<boolean>;
  ownsThread(threadId: string): boolean | Promise<boolean>;
}

export type DelegationControlErrorCode =
  | "INVALID_ARGUMENT"
  | "HARNESS_NOT_FOUND"
  | "THREAD_NOT_FOUND"
  | "THREAD_BUSY"
  | "PARENT_THREAD_AMBIGUOUS"
  | "RESPONSE_TOO_LARGE"
  | "RUNTIME_UNREACHABLE"
  | "UNAUTHORIZED_TARGET"
  | "ENROLLMENT_DENIED"
  | "ENROLLMENT_INVALID"
  | "DELEGATION_FAILED"
  | "MODEL_NOT_IN_CATALOG"
  | "MODEL_NOT_USABLE"
  | "THINKING_NOT_AVAILABLE"
  | "MODEL_SELECTION_UNSUPPORTED"
  | "THINKING_SELECTION_UNSUPPORTED"
  | "INTERNAL_ERROR";

export class DelegationControlError extends Error {
  constructor(
    readonly code: DelegationControlErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DelegationControlError";
  }
}
