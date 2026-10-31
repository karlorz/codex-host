export const GROK_INTERJECT_METHOD = "x.ai/interject";
export const GROK_INTERJECT_FALLBACK_METHOD = "_x.ai/interject";

/** Native queued an interjection; it has not necessarily been drained yet. */
export type GrokInterjectAccepted = { status: "queued" };

export class GrokSteerMissedTurnError extends Error {
  constructor(message = "Grok steer missed the active Turn") {
    super(message);
    this.name = "GrokSteerMissedTurnError";
  }
}

export function parseGrokInterjectResult(value: unknown): GrokInterjectAccepted | null {
  if (value === undefined || value === null) return { status: "queued" };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested =
    record.status === undefined && typeof record.result === "object" && record.result !== null
      ? (record.result as Record<string, unknown>)
      : record;
  const status = nested.status ?? nested.ok;
  if (status === undefined || status === "queued" || status === true) return { status: "queued" };
  return null;
}
