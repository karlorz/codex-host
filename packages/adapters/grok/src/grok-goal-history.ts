import { harnessGoalSchema, type HarnessGoal } from "@codexhost/shared-contracts";
import type { GrokTransportEvent } from "./acp-transport.js";

export function grokEventTimestamp(event: GrokTransportEvent): number | undefined {
  const value = event.metadata?.agentTimestampMs ?? event.metadata?.nativeTimestampMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Read completion evidence without restoring cleared native goal state. */
export function lastCompletedGrokGoal(events: readonly GrokTransportEvent[]): HarnessGoal | null {
  let identity: string | undefined;
  let createdAt: number | undefined;
  let completed: HarnessGoal | null = null;
  for (const event of events) {
    if (event.type === "rewind.marker") {
      identity = undefined;
      createdAt = undefined;
      completed = null;
    }
    if (event.type !== "goal.changed" || event.update === null) continue;
    const update = event.update;
    if (update.status === "cleared") continue;
    if (typeof update.goal_id !== "string" || update.goal_id.length === 0) {
      identity = undefined;
      createdAt = undefined;
      completed = null;
      continue;
    }
    if (identity !== update.goal_id) {
      identity = update.goal_id;
      createdAt = undefined;
      completed = null;
    }
    const timestamp = grokEventTimestamp(event);
    if (createdAt === undefined && update.last_event === "goal_created" && timestamp !== undefined)
      createdAt = Math.floor(timestamp / 1000);
    if (update.status !== "complete") {
      completed = null;
      continue;
    }
    const parsed = harnessGoalSchema.safeParse({
      objective: update.objective,
      status: "complete",
      tokenBudget: update.token_budget ?? null,
      tokensUsed: update.tokens_used,
      timeUsedSeconds:
        typeof update.elapsed_ms === "number" ? Math.floor(update.elapsed_ms / 1000) : undefined,
      createdAt,
      updatedAt: timestamp === undefined ? undefined : Math.floor(timestamp / 1000),
    });
    completed = parsed.success ? parsed.data : null;
  }
  return completed;
}
