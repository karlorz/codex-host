import { describe, expect, it } from "vitest";

import {
  filterRealtimeCallHeaders,
  isRealtimeCallId,
  realtimeCallIdFromLocation,
  realtimeCallParamsSchema,
} from "@codexhost/shared-contracts";

describe("realtime call contract", () => {
  it("drops Desktop credentials, cookies and unlisted headers", () => {
    expect(
      filterRealtimeCallHeaders({
        Authorization: "Bearer desktop-oauth",
        Cookie: "session=private",
        "ChatGPT-Account-Id": "disabled-account",
        "openai-alpha": "quicksilver=v2",
        "Thread-Id": "thread-fixture",
        "Session-Id": "session-fixture",
      }),
    ).toEqual({
      "openai-alpha": "quicksilver=v2",
      "thread-id": "thread-fixture",
      "session-id": "session-fixture",
    });
  });

  it("drops empty and oversized allowlisted header values", () => {
    expect(
      filterRealtimeCallHeaders({ "openai-alpha": "", "thread-id": "t".repeat(4097) }),
    ).toEqual({});
    expect(filterRealtimeCallHeaders(undefined)).toEqual({});
  });

  it("accepts gateway call identities with or without the rtc_ prefix", () => {
    expect(isRealtimeCallId("rtc_fixture-1")).toBe(true);
    expect(isRealtimeCallId("call-123")).toBe(true);
    expect(isRealtimeCallId("rtc_")).toBe(true);
    expect(isRealtimeCallId("")).toBe(false);
    expect(isRealtimeCallId("call/123")).toBe(false);
    expect(isRealtimeCallId(undefined)).toBe(false);
  });

  it("reads an identity from bare values and calls/live paths only", () => {
    expect(realtimeCallIdFromLocation("rtc_fixture")).toBe("rtc_fixture");
    expect(realtimeCallIdFromLocation("/v1/realtime/calls/rtc_fixture?intent=quicksilver")).toBe(
      "rtc_fixture",
    );
    expect(realtimeCallIdFromLocation("/v1/realtime/calls/call-123")).toBe("call-123");
    expect(realtimeCallIdFromLocation("/v1/live/rtc_fixture#fragment")).toBe("rtc_fixture");
    expect(realtimeCallIdFromLocation("/unrecognized/rtc_fixture")).toBeUndefined();
    expect(realtimeCallIdFromLocation("")).toBeUndefined();
  });

  it("rejects a malformed or unbounded create request", () => {
    expect(
      realtimeCallParamsSchema.safeParse({
        operation: "hangup",
        callId: "not/a-call",
      }).success,
    ).toBe(false);
    expect(
      realtimeCallParamsSchema.safeParse({
        operation: "create",
        requestId: "voice",
        body: "{}",
      }).success,
    ).toBe(true);
  });
});
