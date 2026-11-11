import type { HarnessSession, HostSubagentState } from "@codexhost/harness-adapter";
import {
  THREAD_ACTIVITY_LIST_METHOD,
  THREAD_ACTIVITY_READ_METHOD,
  backgroundActivityDetailSchema,
  threadActivityListResultSchema,
  threadActivityStopResultSchema,
  type HostThreadId,
  type BackgroundActivity,
} from "@codexhost/shared-contracts";

function isActiveSubagent(status: HostSubagentState["status"]) {
  return status === "pending" || status === "running";
}

function withChildThread(
  activity: BackgroundActivity,
  child: HostSubagentState,
  resolved: HostSubagentState,
): BackgroundActivity {
  return resolved.subagentId !== child.nativeSubagentId
    ? { ...activity, threadId: resolved.subagentId as HostThreadId }
    : activity;
}

export async function executeExternalActivity(input: {
  session: HarnessSession;
  method: string;
  activityId?: string;
  isCurrent(): boolean;
  materialize(child: HostSubagentState): Promise<HostSubagentState>;
  lookup?(child: HostSubagentState): Promise<HostSubagentState | null>;
  afterList?(): Promise<void>;
}) {
  const capability = input.session.backgroundActivity;
  if (!capability)
    return input.method === THREAD_ACTIVITY_LIST_METHOD
      ? { result: { supported: false, activities: [] } }
      : { error: { code: -32076, message: "Background activity is unsupported" } };
  const current = () => {
    if (!input.isCurrent()) throw new Error("Background activity Session changed");
  };
  const resolveChildren = async (
    activities: readonly BackgroundActivity[],
    mode: "list" | "read",
  ) => {
    const children = capability.subagents?.() ?? [];
    return Promise.all(
      activities.map(async (activity) => {
        if (activity.kind !== "subagent") return activity;
        const child = children.find((entry) => entry.activityId === activity.id)?.state;
        if (!child) return activity;
        current();
        if (mode === "list" && !isActiveSubagent(child.status)) {
          const existing = await input.lookup?.(child);
          current();
          return existing ? withChildThread(activity, child, existing) : activity;
        }
        const resolved = await input.materialize(child);
        current();
        return withChildThread(activity, child, resolved);
      }),
    );
  };
  try {
    current();
    if (input.method === THREAD_ACTIVITY_LIST_METHOD) {
      const result = await capability.list();
      current();
      if (!result.ok) return failure(result.error);
      if (input.afterList) {
        await input.afterList();
        current();
      }
      const activities = await resolveChildren(result.value, "list");
      return { result: threadActivityListResultSchema.parse({ supported: true, activities }) };
    }
    if (input.method === THREAD_ACTIVITY_READ_METHOD) {
      const result = await capability.read(input.activityId ?? "");
      current();
      if (!result.ok) return failure(result.error);
      const [activity] = await resolveChildren([result.value.activity], "read");
      return { result: backgroundActivityDetailSchema.parse({ ...result.value, activity }) };
    }
    const result = await capability.stop(input.activityId ?? "");
    current();
    return result.ok
      ? { result: threadActivityStopResultSchema.parse(result.value) }
      : failure(result.error);
  } catch (error) {
    return {
      error: {
        code: -32083,
        message: error instanceof Error ? error.message : "Background activity failed",
      },
    };
  }
}
function failure(error: { code: string; message: string }) {
  return {
    error: {
      code:
        error.code === "unsupported" ? -32076 : error.code === "invalidRequest" ? -32602 : -32083,
      message: error.message,
    },
  };
}
