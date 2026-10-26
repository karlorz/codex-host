import { z } from "zod";
import { hostInteractionIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

export const THREAD_QUESTIONS_LIST_METHOD = "codexhost/thread/questions/list";
export const THREAD_QUESTION_RESPOND_METHOD = "codexhost/thread/question/respond";
export const THREAD_QUESTION_ACTIVITY_METHOD = "codexhost/thread/question/activity";

export const threadQuestionsParamsSchema = z.strictObject({ threadId: hostThreadIdSchema });
const field = { id: z.string().min(1), prompt: z.string(), optional: z.boolean() };
export const questionAutoResolutionSchema = z.strictObject({
  deadlineUnixMs: z.number().int().min(0).max(8_640_000_000_000_000),
  action: z.enum(["recommended", "decline"]),
  resetOnActivity: z.boolean().optional(),
});
export type QuestionAutoResolution = z.infer<typeof questionAutoResolutionSchema>;
export const threadQuestionSchema = z.strictObject({
  interactionId: hostInteractionIdSchema,
  turnId: hostTurnIdSchema,
  title: z.string().optional(),
  expiresAt: z.string().optional(),
  autoResolution: questionAutoResolutionSchema.optional(),
  questions: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          ...field,
          type: z.literal("choice"),
          multiple: z.boolean(),
          allowOther: z.boolean(),
          options: z
            .array(
              z.strictObject({
                value: z.string().min(1),
                label: z.string(),
                description: z.string().optional(),
              }),
            )
            .min(1),
        }),
        z.strictObject({
          ...field,
          type: z.literal("text"),
          multiline: z.boolean(),
          secret: z.literal(false),
          placeholder: z.string().optional(),
          prefill: z.string().optional(),
        }),
      ]),
    )
    .min(1),
});
export const threadQuestionsResultSchema = z.strictObject({
  questions: z.array(threadQuestionSchema),
});
export const threadQuestionRespondParamsSchema = z.strictObject({
  threadId: hostThreadIdSchema,
  interactionId: hostInteractionIdSchema,
  turnId: hostTurnIdSchema,
  answers: z.record(z.string(), z.array(z.string())),
  cancelled: z.boolean().optional(),
});
export const threadQuestionRespondResultSchema = z.strictObject({ accepted: z.literal(true) });
export const threadQuestionActivityParamsSchema = z.strictObject({
  threadId: hostThreadIdSchema,
  interactionId: hostInteractionIdSchema,
  turnId: hostTurnIdSchema,
});
export const threadQuestionActivityResultSchema = z.strictObject({
  autoResolution: questionAutoResolutionSchema.nullable(),
});
export type ThreadQuestion = z.infer<typeof threadQuestionSchema>;
export type ThreadQuestionRespondParams = z.infer<typeof threadQuestionRespondParamsSchema>;
