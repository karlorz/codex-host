import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import type {
  HostCommandExecutionItem,
  HostEvent,
  HostItemOutcome,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import type { GrokBackgroundKind } from "./grok-background.js";

const POLL_INTERVAL_MS = 1_000;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_READ_BYTES_PER_TICK = 512 * 1024;
const MAX_TOMBSTONES = 1_000;

export interface GrokDetachedBackground {
  turnId: HostTurnId;
  callId: string;
  taskId: string;
  item: HostCommandExecutionItem;
  kind: GrokBackgroundKind;
  description: string;
  outputFile?: string;
}

interface FollowedBackground {
  command: GrokDetachedBackground;
  outputFile: string | undefined;
  offset: number;
  decoder: StringDecoder;
  output: string;
  truncated: boolean;
  timer: NodeJS.Timeout | null;
  reading: Promise<void>;
  outcome: HostItemOutcome | undefined;
  completed: boolean;
  exitCode: number | null | undefined;
  fileOutput: string;
  nativeTruncated: boolean;
}

export interface GrokBackgroundItemsOptions {
  outputLimit: number;
  emit(event: HostEvent): void;
}

export class GrokBackgroundItems {
  readonly #byTaskId = new Map<string, FollowedBackground>();
  readonly #byCallId = new Map<string, string>();
  readonly #tombstones = new Map<string, { callId: string; itemId: HostItemId }>();
  readonly #tombstoneCallIds = new Set<string>();
  readonly #emit: (event: HostEvent) => void;
  readonly #outputLimit: number;

  constructor(options: GrokBackgroundItemsOptions) {
    this.#emit = options.emit;
    this.#outputLimit = options.outputLimit;
  }

  running(): GrokDetachedBackground[] {
    return [...this.#byTaskId.values()]
      .filter((followed) => !followed.completed && !followed.outcome)
      .map((followed) => followed.command);
  }

  taskIds(): string[] {
    return this.running().map((command) => command.taskId);
  }

  commandItemId(taskId: string): HostItemId | undefined {
    return this.#byTaskId.get(taskId)?.command.item.itemId ?? this.#tombstones.get(taskId)?.itemId;
  }

  hasCallId(callId: string): boolean {
    return this.#byCallId.has(callId) || this.#tombstoneCallIds.has(callId);
  }

  follow(command: GrokDetachedBackground): void {
    if (this.#tombstones.has(command.taskId) || this.#tombstoneCallIds.has(command.callId)) {
      return;
    }
    const existing = this.#byTaskId.get(command.taskId);
    if (existing?.completed) return;
    if (existing) {
      existing.command = command;
      this.#byCallId.set(command.callId, command.taskId);
      existing.outputFile ??= command.outputFile;
      if (existing.outputFile && !existing.timer && !existing.completed) {
        existing.timer = setInterval(() => void this.#poll(existing), POLL_INTERVAL_MS);
        existing.timer.unref();
      }
      return;
    }
    const followed: FollowedBackground = {
      command,
      outputFile: command.outputFile,
      offset: 0,
      decoder: new StringDecoder("utf8"),
      output: command.item.output ?? "",
      truncated: command.item.outputTruncated === true,
      timer: null,
      reading: Promise.resolve(),
      outcome: undefined,
      completed: false,
      exitCode: command.item.exitCode,
      fileOutput: "",
      nativeTruncated: false,
    };
    this.#byTaskId.set(command.taskId, followed);
    this.#byCallId.set(command.callId, command.taskId);
    if (followed.outputFile) {
      followed.timer = setInterval(() => void this.#poll(followed), POLL_INTERVAL_MS);
      followed.timer.unref();
    }
  }

  replaceSnapshot(taskIdOrCallId: string, snapshotText: string): boolean {
    const followed = this.#lookup(taskIdOrCallId);
    if (!followed || followed.completed || !snapshotText) return Boolean(followed);
    if (followed.outputFile) {
      return true;
    }
    this.#applySnapshot(followed, snapshotText);
    return true;
  }

  append(taskIdOrCallId: string, text: string): boolean {
    const followed = this.#lookup(taskIdOrCallId);
    if (!followed || followed.completed || !text) return Boolean(followed);
    if (followed.outputFile) {
      return true;
    }
    this.#append(followed, text);
    return true;
  }

  settle(
    taskId: string,
    outcome: HostItemOutcome,
    output?: string,
    outputFile?: string,
    exitCode?: number | null,
    truncated?: boolean,
  ): boolean {
    const followed = this.#byTaskId.get(taskId);
    if (!followed) {
      if (this.#tombstones.has(taskId)) return true;
      return false;
    }
    if (followed.outcome) return true;
    followed.outcome = outcome;
    followed.nativeTruncated ||= truncated === true;
    followed.outputFile ??= outputFile;
    if (exitCode !== undefined) {
      followed.exitCode = exitCode;
    }
    if (followed.timer) clearInterval(followed.timer);
    followed.timer = null;

    if (followed.outputFile) {
      void this.#poll(followed).then(() => this.#complete(followed, outcome));
    } else {
      if (output !== undefined && output.length > 0) {
        this.#applySnapshot(followed, output);
      }
      this.#complete(followed, outcome);
    }
    return true;
  }

  abandonAll(reason: string): void {
    for (const followed of this.#byTaskId.values()) {
      if (followed.timer) {
        clearInterval(followed.timer);
        followed.timer = null;
      }
      this.#complete(followed, followed.outcome ?? { status: "cancelled", reason });
    }
    this.#byTaskId.clear();
    this.#byCallId.clear();
  }

  #lookup(taskIdOrCallId: string): FollowedBackground | undefined {
    return (
      this.#byTaskId.get(taskIdOrCallId) ??
      this.#byTaskId.get(this.#byCallId.get(taskIdOrCallId) ?? "")
    );
  }

  #applySnapshot(followed: FollowedBackground, snapshotText: string): void {
    if (followed.completed) return;
    if (snapshotText.startsWith(followed.output)) {
      const delta = snapshotText.slice(followed.output.length);
      if (delta.length > 0) {
        this.#append(followed, delta);
      }
    } else if (snapshotText !== followed.output) {
      const bounded = snapshotText.slice(0, this.#outputLimit);
      const wasTruncated = snapshotText.length > this.#outputLimit;
      followed.output = bounded;
      followed.truncated ||= wasTruncated;
      followed.command = {
        ...followed.command,
        item: {
          ...followed.command.item,
          output: followed.output,
          outputTruncated: followed.truncated,
        },
      };
      // Command deltas are append-only; the terminal snapshot carries a changed prefix.
    }
  }

  #append(followed: FollowedBackground, text: string): void {
    if (followed.completed || text.length === 0) return;
    const remaining = Math.max(0, this.#outputLimit - followed.output.length);
    const chunk = remaining > 0 ? text.slice(0, remaining) : "";
    if (text.length > remaining) followed.truncated = true;
    if (!chunk) return;
    followed.output += chunk;
    followed.command = {
      ...followed.command,
      item: {
        ...followed.command.item,
        output: followed.output,
        outputTruncated: followed.truncated,
      },
    };
    this.#emit({
      type: "item.updated",
      turnId: followed.command.turnId,
      itemId: followed.command.item.itemId,
      update: { type: "output.append", text: chunk },
    });
  }

  #complete(followed: FollowedBackground, outcome: HostItemOutcome): void {
    if (followed.completed) return;
    followed.completed = true;
    followed.outcome = outcome;
    if (followed.timer) {
      clearInterval(followed.timer);
      followed.timer = null;
    }

    const taskId = followed.command.taskId;
    const callId = followed.command.callId;
    this.#recordTombstone(taskId, callId, followed.command.item.itemId);
    this.#byTaskId.delete(taskId);
    this.#byCallId.delete(callId);

    const resolvedExitCode =
      followed.exitCode !== undefined ? followed.exitCode : followed.command.item.exitCode;

    const item: HostCommandExecutionItem = {
      ...followed.command.item,
      output: followed.output,
      outputTruncated: followed.truncated || followed.nativeTruncated,
      ...(resolvedExitCode !== undefined ? { exitCode: resolvedExitCode } : {}),
    };

    this.#emit({
      type: "item.completed",
      turnId: followed.command.turnId,
      snapshot: { item, outcome },
    });
  }

  #recordTombstone(taskId: string, callId: string, itemId: HostItemId): void {
    if (this.#tombstones.size >= MAX_TOMBSTONES) {
      const oldestKey = this.#tombstones.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.#tombstones.get(oldestKey);
        if (oldest) this.#tombstoneCallIds.delete(oldest.callId);
        this.#tombstones.delete(oldestKey);
      }
    }
    this.#tombstones.set(taskId, { callId, itemId });
    this.#tombstoneCallIds.add(callId);
  }

  #poll(followed: FollowedBackground): Promise<void> {
    if (followed.completed || followed.truncated) {
      if (followed.timer) {
        clearInterval(followed.timer);
        followed.timer = null;
      }
      return followed.reading;
    }
    followed.reading = followed.reading.then(() => this.#read(followed));
    return followed.reading;
  }

  async #read(followed: FollowedBackground): Promise<void> {
    if (!followed.outputFile || followed.completed || followed.truncated) return;
    try {
      const handle = await open(followed.outputFile, "r");
      try {
        let totalReadThisTick = 0;
        const buffer = Buffer.alloc(READ_CHUNK_BYTES);
        while (!followed.completed && !followed.truncated) {
          const toRead = Math.min(buffer.length, MAX_READ_BYTES_PER_TICK - totalReadThisTick);
          if (toRead <= 0) break;
          const { bytesRead } = await handle.read(buffer, 0, toRead, followed.offset);
          if (bytesRead === 0) break;
          followed.offset += bytesRead;
          totalReadThisTick += bytesRead;
          followed.fileOutput += followed.decoder.write(buffer.subarray(0, bytesRead));
          this.#applySnapshot(followed, followed.fileOutput);
          if (followed.fileOutput.length > this.#outputLimit) {
            followed.fileOutput = followed.fileOutput.slice(0, this.#outputLimit);
            followed.truncated = true;
          }
          if (totalReadThisTick >= MAX_READ_BYTES_PER_TICK) break;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
