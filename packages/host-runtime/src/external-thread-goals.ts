import type { HarnessSession } from "@codexhost/harness-adapter";
import { projectCodexGoal, type JsonObject } from "@codexhost/protocol-core";
import { goalOriginSchema, harnessGoalSetSchema } from "@codexhost/shared-contracts";

export const EXTERNAL_GOAL_METHODS = new Set([
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
]);
export async function executeExternalGoal(
  session: HarnessSession,
  threadId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result: JsonObject } | { error: { code: number; message: string } }> {
  const goals = session.goals;
  if (!goals)
    return { error: { code: -32076, message: `External Thread does not support ${method}` } };
  const parsedOrigin = goalOriginSchema.safeParse(params.origin ?? null);
  if (!parsedOrigin.success)
    return { error: { code: -32602, message: "Invalid goal mutation origin" } };
  const origin = parsedOrigin.data;
  try {
    if (method === "thread/goal/get") {
      const read = await goals.read();
      if (!read.ok) return failure(read.error);
      return {
        result: {
          goal: read.value === null ? null : projectCodexGoal(threadId, read.value),
        },
      };
    }
    if (method === "thread/goal/clear") {
      const cleared = await goals.clear({ origin });
      return cleared.ok ? { result: { cleared: cleared.value.cleared } } : failure(cleared.error);
    }
    const parsed = harnessGoalSetSchema.safeParse({
      ...(params.objective == null ? {} : { objective: params.objective }),
      ...(params.status == null ? {} : { status: params.status }),
      ...(Object.hasOwn(params, "tokenBudget") ? { tokenBudget: params.tokenBudget } : {}),
      origin,
    });
    if (!parsed.success)
      return { error: { code: -32602, message: "Invalid external goal mutation" } };
    const set = await goals.set(parsed.data);
    return set.ok
      ? { result: { goal: projectCodexGoal(threadId, set.value) } }
      : failure(set.error);
  } catch {
    return { error: { code: -32076, message: "External goal state or operation is unavailable" } };
  }
}
function failure(error: { code: string; message: string }) {
  return {
    error: { code: error.code === "invalidRequest" ? -32602 : -32076, message: error.message },
  };
}
