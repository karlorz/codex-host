import { describe, expect, it, vi } from "vitest";

import {
  createRendererEnrollmentClient,
  RendererEnrollmentUnavailableError,
} from "../src/renderer-enrollment-client.js";

describe("Renderer enrollment client", () => {
  it("lists and revokes enrollments through fixed Host methods without accepting extra fields", async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        enrollments: [
          {
            enrollmentId: "enroll-1",
            threadId: "thread-1",
            clientId: "cursor-box-grok",
            executablePath: "/synthetic/grok",
            endpoint: "http://127.0.0.1:9",
            issuedAt: "2026-11-07T00:00:00.000Z",
            expiresAt: "2036-11-07T00:00:00.000Z",
            pairing: "machine",
            allowlist: [{ threadId: "thread-1", verbs: ["read", "send"] }],
          },
        ],
      })
      .mockResolvedValueOnce({ enrollmentId: "enroll-1", revoked: true });
    const client = createRendererEnrollmentClient(sendRequest);
    expect(await client.listEnrollments()).toMatchObject({
      enrollments: [{ clientId: "cursor-box-grok", pairing: "machine" }],
    });
    expect(await client.revokeEnrollment("enroll-1")).toEqual({
      enrollmentId: "enroll-1",
      revoked: true,
    });
    expect(sendRequest.mock.calls).toEqual([
      ["codexhost/enrollment/list", {}],
      ["codexhost/enrollment/revoke", { enrollmentId: "enroll-1" }],
    ]);
    await expect(client.revokeEnrollment("")).rejects.toThrow();
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it.each([-32601, -32076])("normalizes enrollment unavailable code %s", async (code) => {
    const sendRequest = vi.fn(async () => {
      throw Object.assign(new Error("private detail"), { code });
    });
    const client = createRendererEnrollmentClient(sendRequest);
    await expect(client.listEnrollments()).rejects.toBeInstanceOf(
      RendererEnrollmentUnavailableError,
    );
    await expect(client.revokeEnrollment("enroll-1")).rejects.toBeInstanceOf(
      RendererEnrollmentUnavailableError,
    );
  });
});
