import path from "node:path";

import type { HarnessError, HarnessResult, HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  nativeCheckpointRefSchema,
  type HarnessId,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import type { GrokNativeSessionLocation, GrokTransportEvent } from "./acp-transport.js";
import { isGrokMethodNotFound } from "./grok-fork.js";
import { mapGrokReplay, resolveGrokTargetPromptIndex } from "./grok-history.js";

export const GROK_REWIND_EXECUTE_METHOD = "_x.ai/rewind/execute";
export const GROK_REWIND_POINTS_METHOD = "_x.ai/rewind/points";

export interface GrokRewindParams {
  sessionId: string;
  targetPromptIndex: number;
  force: true;
  mode: "conversation_only";
}

export interface GrokRewindResponse {
  success: boolean;
  targetPromptIndex: number;
  mode?: string;
  promptText?: string;
  error?: string | null;
}

export interface GrokRewindInput {
  cwd: string;
  harnessId: HarnessId;
  locateSource(sessionId: string): Promise<GrokNativeSessionLocation | null>;
  readHistory(cwd: string, sessionId: string): Promise<GrokTransportEvent[]>;
  rewindAndLoad(params: GrokRewindParams): Promise<{ sessionId: string }>;
  sourceRef: NativeSessionRef;
  checkpoint?: NativeCheckpointRef;
}

function error(code: HarnessError["code"], message: string, retryable = false): HarnessError {
  return { code, message, retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildGrokRewindParams(input: {
  sessionId: string;
  targetPromptIndex: number;
}): GrokRewindParams {
  return {
    sessionId: input.sessionId,
    targetPromptIndex: input.targetPromptIndex,
    force: true,
    mode: "conversation_only",
  };
}

export function parseGrokRewindResponse(value: unknown): GrokRewindResponse | null {
  if (!isRecord(value)) return null;
  const payload =
    typeof value.success !== "boolean" && isRecord(value.result) ? value.result : value;
  if (!isRecord(payload) || typeof payload.success !== "boolean") return null;
  return rewindPayload(payload);
}

function rewindPayload(payload: Record<string, unknown>): GrokRewindResponse | null {
  const targetPromptIndex =
    typeof payload.targetPromptIndex === "number"
      ? payload.targetPromptIndex
      : typeof payload.target_prompt_index === "number"
        ? payload.target_prompt_index
        : null;
  if (targetPromptIndex === null || !Number.isInteger(targetPromptIndex) || targetPromptIndex < 0) {
    return null;
  }
  const promptText =
    typeof payload.promptText === "string"
      ? payload.promptText
      : typeof payload.prompt_text === "string"
        ? payload.prompt_text
        : undefined;
  const rewindError =
    typeof payload.error === "string" ? payload.error : payload.error === null ? null : undefined;
  return {
    success: payload.success === true,
    targetPromptIndex,
    ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}),
    ...(promptText !== undefined ? { promptText } : {}),
    ...(rewindError !== undefined ? { error: rewindError } : {}),
  };
}

async function readSnapshot(
  input: Pick<GrokRewindInput, "cwd" | "harnessId" | "readHistory">,
  sessionId: string,
): Promise<HarnessResult<HostThreadSnapshot>> {
  let history: GrokTransportEvent[];
  try {
    history = await input.readHistory(input.cwd, sessionId);
  } catch {
    return {
      ok: false,
      error: error("nativeFailure", "Grok Native Session history could not be read", true),
    };
  }
  try {
    return { ok: true, value: mapGrokReplay(history, input.harnessId, sessionId, input.cwd) };
  } catch {
    return {
      ok: false,
      error: error("protocolError", "Grok Native Session history is invalid"),
    };
  }
}

export async function rewindGrokSession(
  input: GrokRewindInput,
): Promise<HarnessResult<{ sessionId: string }>> {
  const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRef.success || sourceRef.data.harnessId !== input.harnessId) {
    return {
      ok: false,
      error: error("invalidRequest", "Grok Rewind identity does not belong to Grok"),
    };
  }
  const checkpoint = input.checkpoint
    ? nativeCheckpointRefSchema.safeParse(input.checkpoint)
    : null;
  if (
    checkpoint &&
    (!checkpoint.success ||
      checkpoint.data.harnessId !== input.harnessId ||
      checkpoint.data.nativeSessionId !== sourceRef.data.nativeSessionId)
  ) {
    return {
      ok: false,
      error: error(
        "checkpointNotFound",
        "Grok Rewind Checkpoint does not belong to the source Session",
      ),
    };
  }

  const located = await input.locateSource(sourceRef.data.nativeSessionId);
  if (!located) {
    return {
      ok: false,
      error: error("sessionNotFound", "Grok Native Session is unavailable"),
    };
  }
  const sourceCwd = path.resolve(located.cwd);
  const targetCwd = path.resolve(input.cwd);
  if (sourceCwd !== targetCwd) {
    return {
      ok: false,
      error: error("invalidRequest", "Grok Rewind must stay in the source cwd"),
    };
  }

  let sourceHistory: GrokTransportEvent[];
  try {
    sourceHistory = await input.readHistory(sourceCwd, sourceRef.data.nativeSessionId);
  } catch {
    return {
      ok: false,
      error: error("nativeFailure", "Grok Native Session history could not be read", true),
    };
  }
  // Older shells persisted local goal controls without marking them as non-prompt host Turns.
  // Their apparent sequential indices are not native rewind boundaries.
  if (
    sourceHistory.some(
      (event) =>
        event.type === "user.text" &&
        /^\/goal(?:\s+(?:status|pause|clear|resume))?\s*$/u.test(event.text.trim()) &&
        event.metadata?.hostTurn !== true &&
        event.metadata?.host_turn !== true,
    )
  ) {
    return {
      ok: false,
      error: error(
        "unsupported",
        "Grok history contains legacy goal controls without native rewind boundaries; use a newer Grok build",
      ),
    };
  }
  const source = await readSnapshot(
    { ...input, cwd: sourceCwd, readHistory: async () => sourceHistory },
    sourceRef.data.nativeSessionId,
  );
  if (!source.ok) return source;
  const checkpointId = checkpoint?.success
    ? checkpoint.data.checkpointId
    : source.value.turns.at(-1)?.checkpoint?.checkpointId;
  const retainedCount = source.value.turns.findIndex(
    (turn) => turn.checkpoint?.checkpointId === checkpointId,
  );
  const targetPromptIndex =
    checkpointId === undefined ? null : resolveGrokTargetPromptIndex(source.value, checkpointId);
  if (retainedCount < 0 || targetPromptIndex === null) {
    return {
      ok: false,
      error: error(
        input.checkpoint ? "checkpointNotFound" : "invalidState",
        "Grok Rewind boundary is unavailable",
      ),
    };
  }

  let sessionId: string;
  try {
    const rewound = await input.rewindAndLoad(
      buildGrokRewindParams({
        sessionId: sourceRef.data.nativeSessionId,
        targetPromptIndex,
      }),
    );
    if (rewound.sessionId !== sourceRef.data.nativeSessionId) {
      throw new Error("Grok Rewind returned a different Session identity");
    }
    sessionId = rewound.sessionId;
  } catch (caught) {
    if (isGrokMethodNotFound(caught)) {
      return {
        ok: false,
        error: error("unsupported", "Grok ACP does not support Session Rewind"),
      };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return {
      ok: false,
      error: error(
        "nativeFailure",
        message.includes("Rewind") ? message : "Grok Native Rewind failed",
        true,
      ),
    };
  }

  const derived = await readSnapshot({ ...input, cwd: targetCwd }, sessionId);
  if (!derived.ok) return derived;
  const expectedKeys = source.value.turns
    .slice(0, retainedCount)
    .map((turn) => turn.nativeTurnRef.nativeTurnKey);
  const actualKeys = derived.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey);
  if (
    derived.value.turns.length !== retainedCount ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    derived.value.turns.some((turn) => turn.nativeTurnRef.nativeSessionId !== sessionId)
  ) {
    return {
      ok: false,
      error: error("protocolError", "Grok Native Rewind history is invalid"),
    };
  }

  return { ok: true, value: { sessionId } };
}
