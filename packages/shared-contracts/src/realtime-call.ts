import { z } from "zod";
import { REALTIME_CALL_ID_PATTERN } from "./realtime-call-core.js";

export {
  REALTIME_CALL_METHOD,
  REALTIME_CALL_FORWARDED_HEADERS,
  filterRealtimeCallHeaders,
  REALTIME_CALL_ID_PATTERN,
  isRealtimeCallId,
  realtimeCallIdFromLocation,
} from "./realtime-call-core.js";

const requestId = z.string().min(1).max(128);
export const realtimeCallParamsSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    requestId,
    body: z
      .string()
      .min(1)
      .max(16 << 20),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  z.object({ operation: z.literal("cancel"), requestId }),
  z.object({
    operation: z.literal("hangup"),
    callId: z.string().regex(REALTIME_CALL_ID_PATTERN),
  }),
]);
export const realtimeCallResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.string(),
  headers: z.record(z.string(), z.string()),
});
