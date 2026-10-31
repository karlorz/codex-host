import { describe, expect, it } from "vitest";

import {
  GROK_INTERJECT_FALLBACK_METHOD,
  GROK_INTERJECT_METHOD,
  parseGrokInterjectResult,
} from "../src/grok-interject.js";

describe("Grok interject result", () => {
  it("accepts native queued status and rejects other payloads", () => {
    expect(GROK_INTERJECT_METHOD).toBe("x.ai/interject");
    expect(GROK_INTERJECT_FALLBACK_METHOD).toBe("_x.ai/interject");
    expect(parseGrokInterjectResult({ status: "queued" })).toEqual({ status: "queued" });
    expect(parseGrokInterjectResult({ result: { status: "queued" } })).toEqual({
      status: "queued",
    });
    expect(parseGrokInterjectResult({ ok: true })).toEqual({ status: "queued" });
    expect(parseGrokInterjectResult(null)).toEqual({ status: "queued" });
    expect(parseGrokInterjectResult({ status: "accepted" })).toBeNull();
    expect(parseGrokInterjectResult({})).toEqual({ status: "queued" });
  });
});
