import { z } from "zod";

export const harnessGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
const count = z.number().int().nonnegative().safe();
/** Native accounting. Timestamps are epoch seconds; elapsed time excludes paused intervals. */
export const harnessGoalSchema = z.object({
  objective: z.string().min(1),
  status: harnessGoalStatusSchema,
  tokenBudget: count.positive().nullable(),
  tokensUsed: count,
  timeUsedSeconds: count,
  createdAt: count,
  updatedAt: count,
});
export const goalOriginSchema = z.enum(["user", "automatic"]).nullable();
export const harnessGoalSetSchema = z.object({
  objective: z.string().min(1).optional(),
  status: z.enum(["active", "paused"]).optional(),
  tokenBudget: count.positive().nullable().optional(),
  origin: goalOriginSchema,
});
export type HarnessGoal = z.infer<typeof harnessGoalSchema>;
export type HarnessGoalOrigin = z.infer<typeof goalOriginSchema>;
export type HarnessGoalSet = z.infer<typeof harnessGoalSetSchema>;
