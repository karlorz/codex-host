import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ENROLLMENT_LIST_METHOD, ENROLLMENT_REVOKE_METHOD } from "@codexhost/shared-contracts";
import { EnrollmentAuthority } from "../src/client-enrollment-authority.js";
import { createStubEnrollmentConsent } from "../src/client-enrollment-consent.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("lists and revokes enrollments on Desktop and console without returning tokens", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "enrollment-rpc-"));
  const enrollment = new EnrollmentAuthority({
    hostToken: "host-token",
    dataDirectory: directory,
    consent: createStubEnrollmentConsent("approve"),
    now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    createId: (() => {
      let index = 0;
      return () => {
        const id = ["enroll-host", "thread-host"][index++];
        if (!id) throw new Error("unexpected enrollment id");
        return id;
      };
    })(),
    createToken: () => "host-listed-token",
  });
  const desktop = createFixture({
    environment: { CODEXHOST_DATA_DIR: directory },
    enrollment,
  });
  const consoleHost = createFixture({
    environment: { CODEXHOST_DATA_DIR: directory },
    enrollment,
  });
  try {
    await enrollment.publishBootstrap("http://127.0.0.1:9");
    await enrollment.enroll({
      clientId: "cursor-box-grok",
      executablePath: "/synthetic/grok",
      pairing: "machine",
      attendedHostApprove: true,
    });
    const listed = await consoleHost.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, {});
    expect(listed).toMatchObject({
      result: {
        enrollments: [
          {
            enrollmentId: "enroll-host",
            clientId: "cursor-box-grok",
            pairing: "machine",
          },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toContain("host-listed-token");
    expect(JSON.stringify(listed)).not.toMatch(/"token"/u);
    writeRequest(desktop.desktopInput, { id: 801, method: ENROLLMENT_LIST_METHOD, params: {} });
    expect(await desktop.collector.waitFor((message) => requestId(message, 801))).toMatchObject({
      result: { enrollments: [{ enrollmentId: "enroll-host" }] },
    });
    expect(
      await consoleHost.host.handleConsoleRequest(ENROLLMENT_REVOKE_METHOD, {
        enrollmentId: "enroll-host",
      }),
    ).toEqual({ result: { enrollmentId: "enroll-host", revoked: true } });
    expect(await consoleHost.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, {})).toEqual({
      result: { enrollments: [] },
    });
    expect(
      await consoleHost.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, { extra: true }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(await consoleHost.host.handleConsoleRequest(ENROLLMENT_REVOKE_METHOD, {})).toMatchObject(
      { error: { code: -32602 } },
    );
  } finally {
    await stopFixture(desktop);
    await stopFixture(consoleHost);
    await enrollment.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects enrollment RPCs when the Host has no enrollment authority", async () => {
  const fixture = createFixture();
  try {
    expect(await fixture.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, {})).toMatchObject({
      error: { code: -32000, message: "Enrollment is unavailable on this Host" },
    });
  } finally {
    await stopFixture(fixture);
  }
});
