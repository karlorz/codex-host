import { describe, expect, it } from "vitest";

import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../../src/renderer-cpa-live-voice-config.js";
import { voiceMessages } from "../../src/settings/voice-messages.js";
import {
  voiceSettingsAvailabilityFooter,
  voiceSettingsEffectiveStatus,
  voiceSettingsRouteStatus,
} from "../../src/settings/voice-status.js";
import {
  hashedVoiceTestIdentity,
  isolatedVoiceQualificationFixture,
} from "../voice-evidence-fixture.js";

function owner(paths: Array<"chat" | "work-codex" | "work-grok"> | undefined) {
  const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
  return {
    [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
      enabled: true,
      auditedDesktopVersion: "26.1007.30912",
      auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      desktopVersion: "26.1106.51428",
      desktopPlatform: "darwin",
      desktopAppPath: appPath,
      ...hashedVoiceTestIdentity(),
      ...(paths
        ? {
            isolatedQualification: isolatedVoiceQualificationFixture({
              appPath,
              paths,
            }),
          }
        : {}),
    },
  };
}

const copy = {
  desktopSelected: voiceMessages("en").desktopSelected,
  routeAllowed: voiceMessages("en").routeAllowed,
  pathUnavailable: voiceMessages("en").pathUnavailable,
};

describe("voice settings effective status", () => {
  it("does not call ChatGPT Chat or Work gateway allowed while a chat-only marker is live", () => {
    const status = voiceSettingsEffectiveStatus(owner(["chat"]), {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "gateway",
    });
    expect(status.chatAvailable).toBe(true);
    expect(status.workAvailable).toBe(false);
    expect(status.chatDesktopDefault).toBe(false);
    expect(status.workDesktopDefault).toBe(false);
    expect(status.chatLabel).toBe("ChatGPT Chat");
    expect(status.workLabel).toBe("Work gateway");
    expect(voiceSettingsRouteStatus(status.chatAvailable, status.chatDesktopDefault, copy)).toBe(
      "Allowed on this Desktop",
    );
    expect(voiceSettingsRouteStatus(status.workAvailable, status.workDesktopDefault, copy)).toBe(
      "Not available on this Desktop.",
    );
    expect(
      voiceSettingsAvailabilityFooter(
        { chatExperience: "chatgpt", chatConnection: "desktop", workConnection: "gateway" },
        status,
      ),
    ).toBe("Work voice is not available on this Desktop.");
    expect(JSON.stringify(status)).not.toContain("missing-evidence");
  });

  it("treats saved ChatGPT and Work gateway as allowed on an explicit multi-path marker", () => {
    const status = voiceSettingsEffectiveStatus(owner(["chat", "work-codex"]), {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "gateway",
    });
    expect(status.chatAvailable).toBe(true);
    expect(status.workAvailable).toBe(true);
    expect(voiceSettingsRouteStatus(status.workAvailable, status.workDesktopDefault, copy)).toBe(
      "Allowed on this Desktop",
    );
    expect(
      voiceSettingsAvailabilityFooter(
        { chatExperience: "chatgpt", chatConnection: "desktop", workConnection: "gateway" },
        status,
      ),
    ).toBeUndefined();
  });

  it("keeps explicit Codex Chat Desktop selected without a Chat isolated path", () => {
    const status = voiceSettingsEffectiveStatus(owner(["work-codex"]), {
      chatExperience: "codex",
      chatConnection: "desktop",
      workConnection: "desktop",
    });
    expect(status.chatAvailable).toBe(true);
    expect(status.workAvailable).toBe(true);
    expect(status.chatDesktopDefault).toBe(true);
    expect(status.workDesktopDefault).toBe(true);
    expect(status.chatLabel).toBe("Codex Chat Desktop default");
    expect(status.workLabel).toBe("Work Desktop default");
    expect(voiceSettingsRouteStatus(status.chatAvailable, status.chatDesktopDefault, copy)).toBe(
      "Desktop default selected",
    );
    expect(voiceSettingsRouteStatus(status.workAvailable, status.workDesktopDefault, copy)).toBe(
      "Desktop default selected",
    );
  });

  it("does not disable Desktop default Work because the gateway lane is unqualified", () => {
    const status = voiceSettingsEffectiveStatus(owner(["chat"]), {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "desktop",
    });
    expect(status.workDesktopDefault).toBe(true);
    expect(status.workAvailable).toBe(true);
    expect(voiceSettingsRouteStatus(status.workAvailable, status.workDesktopDefault, copy)).toBe(
      "Desktop default selected",
    );
  });
});
