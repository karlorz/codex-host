import { z } from "zod";
import { hostItemIdSchema, hostThreadIdSchema } from "./ids.js";

export const THREAD_ACTIVITY_LIST_METHOD = "codexhost/thread/activity/list";
export const THREAD_ACTIVITY_READ_METHOD = "codexhost/thread/activity/read";
export const THREAD_ACTIVITY_STOP_METHOD = "codexhost/thread/activity/stop";

export const backgroundActivitySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["task", "monitor", "loop", "subagent"]),
  label: z.string(),
  status: z.enum(["running", "scheduled", "completed", "failed", "cancelled", "unknown"]),
  canStop: z.boolean(),
  /** Existing detached command Item presented by Desktop's native process UI. */
  commandItemId: hostItemIdSchema.optional(),
  schedule: z.string().optional(),
  nextRunAt: z.string().datetime({ offset: true }).optional(),
  relatedActivityId: z.string().optional(),
  threadId: hostThreadIdSchema.optional(),
});
export const backgroundActivityDetailSchema = z.strictObject({
  activity: backgroundActivitySchema,
  output: z.string(),
  truncated: z.boolean(),
});
export const threadActivityParamsSchema = z.strictObject({ threadId: hostThreadIdSchema });
export const threadActivityItemParamsSchema = threadActivityParamsSchema.extend({
  activityId: z.string().min(1),
});
export const threadActivityListResultSchema = z.strictObject({
  supported: z.boolean(),
  activities: z.array(backgroundActivitySchema),
});
export const threadActivityStopResultSchema = z.strictObject({
  outcome: z.enum(["stopped", "alreadyStopped", "notFound"]),
});
export type BackgroundActivity = z.infer<typeof backgroundActivitySchema>;
export type BackgroundActivityDetail = z.infer<typeof backgroundActivityDetailSchema>;
export type BackgroundActivityStopResult = z.infer<typeof threadActivityStopResultSchema>;
