import { describe, expect, it } from "vitest";

import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  CPA_LIVE_VOICE_ENV,
  cpaLiveVoiceHookBootstrap,
  cpaLiveVoiceHookEnabled,
} from "../src/cpa-live-voice-hook.js";

describe("CPA live-voice controller bootstrap", () => {
  it("defaults off", () => {
    expect(cpaLiveVoiceHookEnabled({})).toBe(false);
    expect(cpaLiveVoiceHookBootstrap({})).toBe("");
    expect(cpaLiveVoiceHookEnabled({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe(false);
    expect(cpaLiveVoiceHookEnabled({ [CPA_LIVE_VOICE_ENV]: "true" })).toBe(false);
  });

  it("emits a frozen enable record only when CODEXHOST_CPA_LIVE_VOICE=1", () => {
    const source = cpaLiveVoiceHookBootstrap({ [CPA_LIVE_VOICE_ENV]: "1" });
    expect(source.startsWith("globalThis.__codexhostCpaLiveVoiceHookV1 = Object.freeze(")).toBe(
      true,
    );
    expect(source).toContain(`"auditedDesktopVersion":"${AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION}"`);
    expect(source).toContain(
      `"auditedAppInitialAsset":"${AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET}"`,
    );
    expect(source).toContain('"enabled":true');
    expect(source).not.toContain("clientOwnsCall");
    expect(source).not.toContain("function pa");
  });
});
