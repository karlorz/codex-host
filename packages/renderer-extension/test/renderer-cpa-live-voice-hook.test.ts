import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  THREAD_REALTIME_EXISTING_CALL_GATE,
  auditedAppInitialAssetPresent,
  installCpaLiveVoiceHook,
  readCpaLiveVoiceHookConfig,
  statsigClients,
  wrapCheckGate,
} from "../src/renderer-cpa-live-voice-hook.js";

/** Known Desktop 26.1007.30912 expression. Tests only; not executed as Desktop source. */
const AUDITED_CLIENT_OWNS_CALL_FIXTURE =
  "clientOwnsCall:c===`durable`||pa(e.get(Uo,c),`threadRealtimeExistingCall`)&&Gc(e,`206132468`)";

const AUDITED_ASSET = [`app://-/assets/${AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET}`];

const enabledConfig = {
  enabled: true as const,
  auditedDesktopVersion: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  auditedAppInitialAsset: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
};

function statsigClient() {
  return {
    checkGate(name: string): boolean {
      return name.length > 0;
    },
  };
}

function statsigGlobal(client = statsigClient()) {
  return {
    client,
    globalObject: { __STATSIG__: { instances: { key: client }, firstInstance: client } },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CPA live-voice durable-only predicate", () => {
  it("keeps the audited fixture as durable host OR capability-and-gate", () => {
    expect(AUDITED_CLIENT_OWNS_CALL_FIXTURE).toContain("clientOwnsCall:c===`durable`");
    expect(AUDITED_CLIENT_OWNS_CALL_FIXTURE).toContain(
      `Gc(e,\`${THREAD_REALTIME_EXISTING_CALL_GATE}\`)`,
    );
    expect(AUDITED_CLIENT_OWNS_CALL_FIXTURE).toContain("threadRealtimeExistingCall");
  });
});

describe("CPA live-voice hook gating", () => {
  it("stays off without an explicit enable config", () => {
    expect(readCpaLiveVoiceHookConfig({})).toBeNull();
    const { client, globalObject } = statsigGlobal();
    const hook = installCpaLiveVoiceHook({
      config: { ...enabledConfig, enabled: false },
      resourceNames: AUDITED_ASSET,
      globalThis: globalObject,
    });
    expect(hook.status).toBe("disabled");
    expect(client.checkGate(THREAD_REALTIME_EXISTING_CALL_GATE)).toBe(true);
  });

  it("fails closed when the audited app-initial asset is absent", () => {
    expect(
      auditedAppInitialAssetPresent(
        ["app://-/assets/other.js"],
        enabledConfig.auditedAppInitialAsset,
      ),
    ).toBe(false);
    const { client, globalObject } = statsigGlobal();
    const hook = installCpaLiveVoiceHook({
      config: enabledConfig,
      resourceNames: ["app://-/assets/app-initial-deadbeef.js"],
      globalThis: globalObject,
    });
    expect(hook.status).toBe("unsupported");
    expect(client.checkGate(THREAD_REALTIME_EXISTING_CALL_GATE)).toBe(true);
  });

  it("fails closed when an injected Desktop version is not the audited build", () => {
    const { client, globalObject } = statsigGlobal();
    const hook = installCpaLiveVoiceHook({
      config: { ...enabledConfig, desktopVersion: "26.9999.0" },
      resourceNames: AUDITED_ASSET,
      globalThis: globalObject,
    });
    expect(hook.status).toBe("unsupported");
    expect(client.checkGate(THREAD_REALTIME_EXISTING_CALL_GATE)).toBe(true);
  });
});

describe("CPA live-voice existing-call gate override", () => {
  it("reads each registered Statsig client once", () => {
    const { client, globalObject } = statsigGlobal();
    expect(statsigClients(globalObject)).toEqual([client]);
    expect(statsigClients({})).toEqual([]);
  });

  it("forces only the existing-call gate off and passes other gates through", () => {
    const client = statsigClient();
    expect(wrapCheckGate(client)).toBe(true);
    expect(wrapCheckGate(client)).toBe(false);
    expect(client.checkGate(THREAD_REALTIME_EXISTING_CALL_GATE)).toBe(false);
    expect(client.checkGate("other_gate")).toBe(true);
  });

  it("activates on the audited asset and restores on dispose", () => {
    const { client, globalObject } = statsigGlobal();
    const hook = installCpaLiveVoiceHook({
      config: enabledConfig,
      resourceNames: AUDITED_ASSET,
      globalThis: globalObject,
    });
    expect(hook.status).toBe("active");
    expect(client.checkGate(THREAD_REALTIME_EXISTING_CALL_GATE)).toBe(false);
    hook.dispose();
    expect(client.checkGate(THREAD_REALTIME_EXISTING_CALL_GATE)).toBe(true);
  });

  it("wraps a Statsig client registered after document-start injection", () => {
    vi.useFakeTimers();
    const globalObject: Record<string, unknown> = {};
    const hook = installCpaLiveVoiceHook({
      config: enabledConfig,
      resourceNames: AUDITED_ASSET,
      globalThis: globalObject,
    });
    expect(hook.status).toBe("pending");
    const client = statsigClient();
    globalObject.__STATSIG__ = { firstInstance: client };
    vi.advanceTimersByTime(250);
    expect(hook.status).toBe("active");
    expect(client.checkGate(THREAD_REALTIME_EXISTING_CALL_GATE)).toBe(false);
    hook.dispose();
  });
});
