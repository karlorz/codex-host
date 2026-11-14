import { expect, it, vi } from "vitest";
import {
  REALTIME_CALL_METHOD,
  VOICE_SETTINGS_METHOD,
  VOICE_GATEWAY_STATUS_METHOD,
} from "@codexhost/shared-contracts";
import { createFixture, stopFixture, writeRequest, requestId } from "./app-server-host-fixture.js";

it("validates voice settings and proxies only through the local console service", async () => {
  const voiceSettings = vi.fn(async () => ({ settings: "fixture" }));
  const fixture = createFixture({
    environment: { CODEX_HOME: "/nonexistent-codexhost-voice-test" },
    consoleOpener: { open: vi.fn(), voiceSettings },
  });
  try {
    writeRequest(fixture.desktopInput, {
      id: 801,
      method: VOICE_SETTINGS_METHOD,
      params: { operation: "get" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 801))).toMatchObject({
      result: { settings: "fixture" },
    });
    expect(voiceSettings).toHaveBeenCalledWith({ operation: "get" });
    writeRequest(fixture.desktopInput, {
      id: 802,
      method: VOICE_SETTINGS_METHOD,
      params: { operation: "set", settings: {} },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 802))).toMatchObject({
      error: { code: -32602 },
    });
    expect(voiceSettings).toHaveBeenCalledOnce();
    expect(fixture.official.stdin.readableLength).toBe(0);
    expect(
      await fixture.host.handleConsoleRequest(VOICE_SETTINGS_METHOD, { operation: "get" }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(await fixture.host.handleConsoleRequest(VOICE_GATEWAY_STATUS_METHOD, {})).toEqual({
      result: false,
    });
    expect(
      await fixture.host.handleClientRequest(VOICE_SETTINGS_METHOD, { operation: "get" }),
    ).toEqual({
      result: { settings: "fixture" },
    });
    expect(await fixture.host.handleClientRequest(VOICE_GATEWAY_STATUS_METHOD, {})).toEqual({
      result: false,
    });
    expect(voiceSettings).toHaveBeenCalledTimes(2);
    expect(
      await fixture.host.handleClientRequest(REALTIME_CALL_METHOD, {
        operation: "cancel",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ result: { status: 204, body: "", headers: {} } });
    expect(
      await fixture.host.handleClientRequest(REALTIME_CALL_METHOD, { operation: "create" }),
    ).toMatchObject({
      error: {
        code: -32090,
        message: "Configured voice gateway request failed",
        data: { stage: "request" },
      },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("serves Host voice contracts on the shared Thread service client channel", async () => {
  const voiceSettings = vi.fn(async () => ({ settings: "shared" }));
  const fixture = createFixture({
    externalOnly: true,
    environment: { CODEX_HOME: "/nonexistent-codexhost-voice-test" },
    consoleOpener: { open: vi.fn(), voiceSettings },
  });
  try {
    expect(
      await fixture.host.handleClientRequest(VOICE_SETTINGS_METHOD, { operation: "get" }),
    ).toEqual({ result: { settings: "shared" } });
    expect(await fixture.host.handleClientRequest(VOICE_GATEWAY_STATUS_METHOD, {})).toEqual({
      result: false,
    });
    expect(
      await fixture.host.handleClientRequest(REALTIME_CALL_METHOD, {
        operation: "cancel",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ result: { status: 204, body: "", headers: {} } });
    expect(
      await fixture.host.handleClientRequest("codexhost/voice/not-a-contract", {}),
    ).toMatchObject({ error: { code: -32601 } });
  } finally {
    await stopFixture(fixture);
  }
});

it("keeps Host voice settings on the shared service when the local console is missing", async () => {
  const fixture = createFixture({ externalOnly: true });
  try {
    expect(
      await fixture.host.handleClientRequest(VOICE_SETTINGS_METHOD, { operation: "get" }),
    ).toMatchObject({
      error: { code: -32090, message: "Voice settings are available on the local Host only" },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("rejects voice operations when there is no local console service", async () => {
  const fixture = createFixture();
  try {
    writeRequest(fixture.desktopInput, {
      id: 803,
      method: VOICE_SETTINGS_METHOD,
      params: { operation: "get" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 803))).toMatchObject({
      error: { code: -32090 },
    });
  } finally {
    await stopFixture(fixture);
  }
});
