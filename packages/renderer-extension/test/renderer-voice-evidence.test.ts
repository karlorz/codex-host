import { describe, expect, it } from "vitest";

import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../src/renderer-cpa-live-voice-config.js";
import {
  chatVoiceUserFacingUnavailable,
  evaluateVoiceEvidence,
  startupVoiceGate,
  workVoicePathDecision,
  workVoiceUserFacingUnavailable,
} from "../src/renderer-voice-evidence.js";
import {
  profileIdentityKey,
  voiceImplementationRevision,
  voiceProfileDigest,
} from "../src/renderer-voice-profiles.js";
import {
  hashedVoiceTestIdentity,
  reviewedVoiceEvidenceRecord,
  TEST_REVIEWED_ASAR_DIGEST,
  TEST_REVIEWED_NATIVE_BUILD,
} from "./voice-evidence-fixture.js";

function chatRecord(
  overrides: Parameters<typeof reviewedVoiceEvidenceRecord>[0] extends infer Input
    ? Partial<Input> & { connected?: boolean; startAcknowledged?: boolean; speech?: unknown }
    : never = {},
) {
  const { connected, startAcknowledged, speech, ...input } = overrides as {
    connected?: boolean;
    startAcknowledged?: boolean;
    speech?: { attended: boolean; bothDirections: boolean; witness?: string; run?: string };
    path?: "chat";
    desktopPlatform?: string;
    desktopVersion?: string;
    desktopBuild?: string;
    asarDigest?: string;
    implementationRevision?: string;
  };
  return {
    ...reviewedVoiceEvidenceRecord({
      path: "chat",
      desktopPlatform: "darwin",
      desktopVersion: "26.1106.51428",
      ...input,
    }),
    ...(connected === undefined ? {} : { connected }),
    ...(startAcknowledged === undefined ? {} : { startAcknowledged }),
    ...(speech === undefined ? {} : { speech }),
  };
}

function hashedGate(
  records: ReturnType<typeof reviewedVoiceEvidenceRecord>[] = [],
  extra: Record<string, unknown> = {},
) {
  return startupVoiceGate({
    enabled: true,
    auditedDesktopVersion: "26.1007.30912",
    auditedAppInitialAsset: "app-initial-6350d04672d0.js",
    desktopVersion: "26.1106.51428",
    desktopPlatform: "darwin",
    ...hashedVoiceTestIdentity(),
    ...(records.length > 0 ? { voiceEvidence: records } : {}),
    ...extra,
  });
}

describe("voice evidence evaluator", () => {
  it("does not qualify START acknowledgment without a connected Chat session", () => {
    const result = evaluateVoiceEvidence(
      chatRecord({
        startAcknowledged: true,
        connected: false,
      }),
    );
    expect(result.qualified).toBe(false);
    expect(result.reason).toBe("start-acknowledged-without-connection");
  });

  it("does not qualify a Work route-only report", () => {
    const result = evaluateVoiceEvidence({
      ...reviewedVoiceEvidenceRecord({
        path: "work-grok",
        desktopPlatform: "darwin",
        desktopVersion: "26.1106.51428",
      }),
      stages: { structural: true, activation: true, connection: true },
      startAcknowledged: true,
      connected: true,
      gatewayOwned: false,
    });
    expect(result.qualified).toBe(false);
    expect(result.reason).toBe("route-only-without-connected-gateway");
  });

  it("requires attended speech provenance", () => {
    const result = evaluateVoiceEvidence(
      chatRecord({
        speech: { attended: true, bothDirections: true },
      }),
    );
    expect(result.qualified).toBe(false);
    expect(result.reason).toBe("attended-speech-missing-provenance");
  });

  it("rejects a missing profile digest or implementation revision", () => {
    const missingRevision = chatRecord();
    missingRevision.implementationRevision = "";
    expect(evaluateVoiceEvidence(missingRevision).reason).toBe("missing-implementation-revision");
    const stale = chatRecord();
    stale.profileDigest = "deadbeefdeadbeef";
    expect(evaluateVoiceEvidence(stale).reason).toBe("stale-profile-digest");
    expect(voiceProfileDigest("chat", "darwin", "26.1106.51428")).toBe(chatRecord().profileDigest);
  });

  it("rejects a changed implementation revision", () => {
    expect(
      evaluateVoiceEvidence(chatRecord({ implementationRevision: "deadbeefdeadbeef" })).reason,
    ).toBe("implementation-revision-mismatch");
  });

  it("rejects reviewed evidence that omits native artifact identity", () => {
    const record = chatRecord();
    delete record.desktopBuild;
    delete record.asarDigest;
    expect(evaluateVoiceEvidence(record).reason).toBe("missing-native-identity");
  });

  it("accepts a complete Chat record and keeps Work lanes independent", () => {
    expect(evaluateVoiceEvidence(chatRecord()).qualified).toBe(true);
    const gate = hashedGate([chatRecord()]);
    expect(gate.chat.enabled).toBe(true);
    expect(gate.chat.policy).toBe("reviewed");
    expect(gate["work-codex"].enabled).toBe(false);
    expect(gate["work-grok"].enabled).toBe(false);
  });

  it("does not enable hashed Chat or Work from constants when evidence is missing", () => {
    const gate = hashedGate();
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("missing-evidence");
    expect(gate["work-codex"].enabled).toBe(false);
    expect(gate["work-grok"].enabled).toBe(false);
  });

  it("does not match an underspecified record to a public version", () => {
    const record = chatRecord();
    delete record.desktopBuild;
    delete record.asarDigest;
    const gate = hashedGate([record]);
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("stale-or-wrong-platform-evidence");
  });

  it("keeps named Chat and Work/Codex as explicit legacy-retained policy", () => {
    const gate = startupVoiceGate({
      enabled: true,
      auditedDesktopVersion: "26.1007.30912",
      auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      desktopVersion: "26.1027.61615",
      desktopPlatform: "darwin",
    });
    expect(gate.chat.enabled).toBe(true);
    expect(gate.chat.policy).toBe("legacy-retained");
    expect(gate["work-codex"].enabled).toBe(true);
    expect(gate["work-codex"].policy).toBe("legacy-retained");
    expect(gate["work-grok"].enabled).toBe(false);
    expect(gate.work.enabled).toBe(true);
  });

  it("does not let a Work/Codex record qualify Work/Grok", () => {
    const gate = hashedGate([
      reviewedVoiceEvidenceRecord({
        path: "work-codex",
        desktopPlatform: "darwin",
        desktopVersion: "26.1106.51428",
      }),
    ]);
    expect(gate["work-codex"].enabled).toBe(true);
    expect(gate["work-grok"].enabled).toBe(false);
    expect(gate.chat.enabled).toBe(false);
  });

  it("does not fall back to legacy when matching evidence failed", () => {
    const gate = startupVoiceGate({
      enabled: true,
      auditedDesktopVersion: "26.1007.30912",
      auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      desktopVersion: "26.1027.61615",
      desktopPlatform: "darwin",
      ...hashedVoiceTestIdentity(),
      voiceEvidence: [
        {
          ...reviewedVoiceEvidenceRecord({
            path: "chat",
            desktopPlatform: "darwin",
            desktopVersion: "26.1027.61615",
          }),
          connected: false,
          startAcknowledged: true,
        },
      ],
    });
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("start-acknowledged-without-connection");
  });

  it("rejects stale or wrong-platform evidence at startup", () => {
    const gate = hashedGate([chatRecord()], { desktopPlatform: "win32" });
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("stale-or-wrong-platform-evidence");
  });

  it("rejects mismatched native build identity", () => {
    const gate = hashedGate([
      reviewedVoiceEvidenceRecord({
        path: "chat",
        desktopPlatform: "darwin",
        desktopVersion: "26.1106.51428",
        desktopBuild: "99999",
      }),
    ]);
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("stale-or-wrong-platform-evidence");
    expect(profileIdentityKey("chat", "darwin", "26.1106.51428")).toBe("chat:darwin:26.1106.51428");
  });

  it("rejects the same public version with a different asar digest", () => {
    const gate = hashedGate([
      reviewedVoiceEvidenceRecord({
        path: "chat",
        desktopPlatform: "darwin",
        desktopVersion: "26.1106.51428",
        asarDigest: `sha256:${"cd".repeat(32)}`,
      }),
    ]);
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("stale-or-wrong-platform-evidence");
  });

  it("rejects reviewed evidence when the installed native identity is missing", () => {
    const gate = startupVoiceGate({
      enabled: true,
      auditedDesktopVersion: "26.1007.30912",
      auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      desktopVersion: "26.1106.51428",
      desktopPlatform: "darwin",
      implementationRevision: voiceImplementationRevision(),
      voiceEvidence: [chatRecord()],
    });
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("stale-or-wrong-platform-evidence");
  });

  it("enables an isolated qualification path without promoting reviewed evidence", () => {
    const gate = hashedGate([], {
      desktopAppPath: "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app",
      isolatedQualification: {
        path: "chat",
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath: "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app",
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(gate.chat.enabled).toBe(true);
    expect(gate.chat.policy).toBe("unreviewed");
    expect(gate.chat.reason).toBe("isolated-qualification");
    expect(gate["work-codex"].enabled).toBe(false);
    expect(gate["work-grok"].enabled).toBe(false);
  });

  it("enables isolated Work/Codex without Chat, Grok, or reviewed evidence", () => {
    expect(voiceProfileDigest("work", "darwin", "26.1106.51428")).toEqual(
      expect.stringMatching(/^[0-9a-f]{16}$/),
    );
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const gate = hashedGate([], {
      desktopAppPath: appPath,
      isolatedQualification: {
        path: "work-codex",
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath,
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(gate["work-codex"].enabled).toBe(true);
    expect(gate["work-codex"].policy).toBe("unreviewed");
    expect(gate["work-codex"].reason).toBe("isolated-qualification");
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("missing-evidence");
    expect(gate["work-grok"].enabled).toBe(false);
  });

  it("enables isolated Work/Grok independently of Work/Codex", () => {
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const gate = hashedGate([], {
      desktopAppPath: appPath,
      isolatedQualification: {
        path: "work-grok",
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath,
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(gate["work-grok"].enabled).toBe(true);
    expect(gate["work-grok"].policy).toBe("unreviewed");
    expect(gate["work-grok"].reason).toBe("isolated-qualification");
    expect(gate["work-codex"].enabled).toBe(false);
    expect(gate.chat.enabled).toBe(false);
  });

  it("enables an explicit isolated path set without promoting reviewed evidence or other paths", () => {
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const gate = hashedGate([], {
      desktopAppPath: appPath,
      isolatedQualification: {
        path: "chat",
        paths: ["chat", "work-codex"],
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath,
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(gate.chat.enabled).toBe(true);
    expect(gate["work-codex"].enabled).toBe(true);
    expect(gate.chat.policy).toBe("unreviewed");
    expect(gate["work-codex"].policy).toBe("unreviewed");
    expect(gate["work-grok"].enabled).toBe(false);
    expect(gate["work-grok"].reason).toBe("missing-evidence");
  });

  it("rejects an isolated marker that mixes an unknown path token or production app path", () => {
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const unknown = hashedGate([], {
      desktopAppPath: appPath,
      isolatedQualification: {
        path: "chat",
        paths: ["chat", "*"],
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath,
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(unknown.chat.enabled).toBe(false);
    const production = hashedGate([], {
      desktopAppPath: "/Applications/ChatGPT.app",
      isolatedQualification: {
        paths: ["chat", "work-codex", "work-grok"],
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath: "/Applications/ChatGPT.app",
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(production.chat.enabled).toBe(false);
    expect(production["work-codex"].enabled).toBe(false);
  });

  it("rejects unparseable expiry, malformed path sets, and a missing or wrong platform", () => {
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const base = {
      path: "chat" as const,
      run: "2026-11-14-isolated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      desktopVersion: "26.1106.51428",
      desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
      desktopPlatform: "darwin",
      asarDigest: TEST_REVIEWED_ASAR_DIGEST,
      appPath,
      implementationRevision: voiceImplementationRevision(),
      label: "unqualified-isolated" as const,
    };
    expect(
      hashedGate([], { desktopAppPath: appPath, isolatedQualification: base }).chat.enabled,
    ).toBe(true);
    expect(
      hashedGate([], {
        desktopAppPath: appPath,
        isolatedQualification: { ...base, expiresAt: "not-a-date" },
      }).chat.enabled,
    ).toBe(false);
    expect(
      hashedGate([], {
        desktopAppPath: appPath,
        isolatedQualification: { ...base, path: "chat", paths: "bad" },
      }).chat.enabled,
    ).toBe(false);
    expect(
      hashedGate([], {
        desktopAppPath: appPath,
        isolatedQualification: { ...base, paths: ["chat", "chat"] },
      }).chat.enabled,
    ).toBe(false);
    expect(
      hashedGate([], {
        desktopAppPath: appPath,
        isolatedQualification: { ...base, desktopPlatform: undefined },
      }).chat.enabled,
    ).toBe(false);
    expect(
      hashedGate([], {
        desktopAppPath: appPath,
        isolatedQualification: { ...base, desktopPlatform: "win32" },
      }).chat.enabled,
    ).toBe(false);
  });

  it("enables an isolated Windows hashed Chat candidate without promoting reviewed evidence", () => {
    const appPath =
      "C:\\Users\\karlchow\\AppData\\Local\\.codexhost\\update-impact\\26.1106.51428\\bundle\\app\\ChatGPT.exe";
    const gate = hashedGate([], {
      desktopPlatform: "win32",
      desktopAppPath: appPath,
      isolatedQualification: {
        path: "chat",
        run: "2026-11-15-isolated-win32",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "win32",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath,
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(voiceProfileDigest("chat", "win32", "26.1106.51428")).toEqual(
      expect.stringMatching(/^[0-9a-f]{16}$/),
    );
    expect(gate.chat.enabled).toBe(true);
    expect(gate.chat.policy).toBe("unreviewed");
    expect(gate.chat.reason).toBe("isolated-qualification");
    expect(gate["work-codex"].enabled).toBe(false);
    expect(gate["work-grok"].enabled).toBe(false);
  });

  it("keeps Windows hashed Chat unreviewed without an isolated marker", () => {
    const gate = hashedGate([], { desktopPlatform: "win32" });
    expect(gate.chat.enabled).toBe(false);
    expect(gate.chat.reason).toBe("missing-evidence");
    const reviewed = hashedGate(
      [
        reviewedVoiceEvidenceRecord({
          path: "chat",
          desktopPlatform: "win32",
          desktopVersion: "26.1106.51428",
        }),
      ],
      { desktopPlatform: "win32" },
    );
    expect(reviewed.chat.enabled).toBe(false);
    expect(reviewed.chat.reason).toBe("missing-evidence");
  });

  it("rejects a Windows Store production app path as an isolated Chat marker", () => {
    const appPath =
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
    const gate = hashedGate([], {
      desktopPlatform: "win32",
      desktopAppPath: appPath,
      isolatedQualification: {
        path: "chat",
        run: "2026-11-15-isolated-win32",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "win32",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath,
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(gate.chat.enabled).toBe(false);
  });

  it("does not treat an expired or wrong-app isolated marker as production evidence", () => {
    const expired = hashedGate([], {
      desktopAppPath: "/tmp/candidate/ChatGPT.app",
      isolatedQualification: {
        path: "chat",
        run: "expired",
        expiresAt: new Date(Date.now() - 1).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath: "/tmp/candidate/ChatGPT.app",
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(expired.chat.enabled).toBe(false);
    const wrongApp = hashedGate([], {
      desktopAppPath: "/Applications/ChatGPT.app",
      isolatedQualification: {
        path: "chat",
        run: "scratch",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
        desktopPlatform: "darwin",
        asarDigest: TEST_REVIEWED_ASAR_DIGEST,
        appPath: "/tmp/candidate/ChatGPT.app",
        implementationRevision: voiceImplementationRevision(),
        label: "unqualified-isolated",
      },
    });
    expect(wrongApp.chat.enabled).toBe(false);
  });

  it("keeps missing-evidence internally and uses the existing unqualified Work sentence for toasts", () => {
    const owner = {
      [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
        enabled: true,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        desktopVersion: "26.1106.51428",
        desktopPlatform: "darwin",
        ...hashedVoiceTestIdentity(),
        voiceEvidence: [],
      },
    };
    expect(workVoicePathDecision(owner, "work-codex").reason).toBe("missing-evidence");
    expect(workVoiceUserFacingUnavailable(owner, "work-codex")).toBe(
      "Work voice is not qualified on this Desktop.",
    );
    expect(workVoiceUserFacingUnavailable(owner, "work-grok")).toBe(
      "Work voice is not qualified on this Desktop.",
    );
    expect(startupVoiceGate(owner[CPA_LIVE_VOICE_HOOK_GLOBAL]).chat.reason).toBe(
      "missing-evidence",
    );
    expect(chatVoiceUserFacingUnavailable(owner)).toBe(
      "Chat voice is not qualified on this Desktop.",
    );
  });
});
