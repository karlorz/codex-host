import { describe, expect, it } from "vitest";

import {
  isolatedQualificationPathSet,
  isIsolatedVoiceQualification,
} from "../src/renderer-cpa-live-voice-config.js";
import { isolatedVoiceQualificationFixture } from "./voice-evidence-fixture.js";

const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    ...isolatedVoiceQualificationFixture({ appPath }),
    ...overrides,
  };
}

describe("isolated voice qualification renderer parser", () => {
  it("rejects unparseable, empty, and expired expiry while keeping a valid marker", () => {
    expect(isIsolatedVoiceQualification(valid({ expiresAt: "not-a-date" }))).toBe(false);
    expect(isIsolatedVoiceQualification(valid({ expiresAt: "" }))).toBe(false);
    expect(
      isIsolatedVoiceQualification(valid({ expiresAt: new Date(Date.now() - 1).toISOString() })),
    ).toBe(false);
    expect(isIsolatedVoiceQualification(valid())).toBe(true);
  });

  it("rejects malformed explicit path sets instead of falling back to legacy path", () => {
    expect(isolatedQualificationPathSet({ path: "chat", paths: "bad" })).toBeUndefined();
    expect(isolatedQualificationPathSet({ path: "chat", paths: { chat: true } })).toBeUndefined();
    expect(isolatedQualificationPathSet({ path: "chat", paths: ["chat", "chat"] })).toBeUndefined();
    expect(isolatedQualificationPathSet({ path: "chat", paths: ["chat", "*"] })).toBeUndefined();
    expect(isolatedQualificationPathSet({ path: "chat", paths: [] })).toBeUndefined();
    expect(isolatedQualificationPathSet({ path: "work-codex", paths: ["chat"] })).toBeUndefined();
    expect(isolatedQualificationPathSet({ path: "chat" })).toEqual(["chat"]);
    expect(isolatedQualificationPathSet({ paths: ["work-codex", "chat"] })).toEqual([
      "chat",
      "work-codex",
    ]);
    expect(isIsolatedVoiceQualification(valid({ path: "chat", paths: "bad" }))).toBe(false);
    expect(isIsolatedVoiceQualification(valid({ path: "chat" }))).toBe(true);
  });

  it("requires desktopPlatform and does not infer a missing platform", () => {
    expect(isIsolatedVoiceQualification({ ...valid(), desktopPlatform: undefined })).toBe(false);
    expect(isIsolatedVoiceQualification(valid({ desktopPlatform: "win32" }))).toBe(true);
    expect(isIsolatedVoiceQualification(valid({ desktopPlatform: "mac" }))).toBe(false);
  });
});
