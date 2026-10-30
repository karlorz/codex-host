import { harnessGoalSchema, type HarnessGoal, type JsonObject } from "@codexhost/shared-contracts";

export function projectCodexGoal(threadId: string, goal: HarnessGoal): JsonObject {
  return { ...harnessGoalSchema.parse(goal), threadId };
}
export function projectCodexGoalChanged(threadId: string, goal: HarnessGoal | null): JsonObject {
  return goal === null
    ? { method: "thread/goal/cleared", params: { threadId } }
    : {
        method: "thread/goal/updated",
        params: { threadId, goal: projectCodexGoal(threadId, goal) },
      };
}
