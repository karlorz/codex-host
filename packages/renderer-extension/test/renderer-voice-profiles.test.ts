import { describe, expect, it } from "vitest";

import { selectVoiceAssets, supportsVoiceVersion } from "../src/renderer-voice-assets.js";
import {
  CLIENT_OWNED_VOICE_ASSETS,
  HASHED_WEBPACK_VOICE_VERSION,
  HISTORICAL_CPA_LIVE_VOICE_DESKTOP_VERSION,
  NATIVE_CHAT_VOICE_ASSETS,
  digestJson,
  hashedVoiceProfileSupported,
  nativeChatVoiceKind,
  reviewedOverlayHookDesktopVersions,
  voiceImplementationRevision,
  voiceProfileOwner,
  voiceProfilePins,
  voiceQualificationArtifact,
} from "../src/renderer-voice-profiles.js";

const urls = (assets: readonly string[]) => assets.map((asset) => `app://-/assets/${asset}`);

describe("audited voice profile owner", () => {
  it("keeps Chat and Work identities distinct for the current pin", () => {
    expect(voiceProfilePins.chatVersion).toBe("26.1027.61615");
    expect(voiceProfilePins.workVersion).toBe("26.1027.61615");
    expect(voiceProfilePins.chatStart).toContain("start-voice-");
    expect(voiceProfilePins.overlayAsset).toContain("avatar-overlay-native-page-");
    expect(
      NATIVE_CHAT_VOICE_ASSETS.find((profile) => profile.version === voiceProfilePins.chatVersion)
        ?.roles.initial.SPn,
    ).toBe("etn");
    expect(
      CLIENT_OWNED_VOICE_ASSETS.find((profile) => profile.version === voiceProfilePins.workVersion)
        ?.fetch,
    ).toBe("Odr");
  });

  it("selects exact platform assets for the same public version", () => {
    const darwin = selectVoiceAssets(NATIVE_CHAT_VOICE_ASSETS, [], "26.1021.31345", "darwin");
    const windows = selectVoiceAssets(NATIVE_CHAT_VOICE_ASSETS, [], "26.1021.31345", "win32");
    expect(darwin?.initial).toBe("app-initial-feb30b196d11.js");
    expect(windows?.initial).toBe("app-initial-438d1df57f70.js");
    expect(darwin?.roles.startShape).toBe("entityBusiness");
  });

  it("rejects the wrong platform, mixed assets, absent metadata and unknown builds", () => {
    expect(
      selectVoiceAssets(
        NATIVE_CHAT_VOICE_ASSETS,
        urls(["app-initial-feb30b196d11.js", "app-shared-2cae01273bae.js"]),
        "26.1021.31345",
        "win32",
      ),
    ).toBeUndefined();
    expect(
      selectVoiceAssets(
        NATIVE_CHAT_VOICE_ASSETS,
        urls(["app-initial-feb30b196d11.js", "app-shared-955d52676f9c.js"]),
        "26.1021.31345",
        "darwin",
      ),
    ).toBeUndefined();
    expect(selectVoiceAssets(NATIVE_CHAT_VOICE_ASSETS, [], "26.1021.31345")).toBeUndefined();
    expect(selectVoiceAssets(NATIVE_CHAT_VOICE_ASSETS, [], "26.1099.1", "darwin")).toBeUndefined();
    expect(supportsVoiceVersion(NATIVE_CHAT_VOICE_ASSETS, "26.1099.1")).toBe(false);
  });

  it("does not treat hashed macOS Chat as a Windows profile", () => {
    expect(
      hashedVoiceProfileSupported({
        desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
        desktopPlatform: "darwin",
      }),
    ).toBe(true);
    expect(
      hashedVoiceProfileSupported({
        desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
        desktopPlatform: "win32",
      }),
    ).toBe(false);
    expect(
      nativeChatVoiceKind({
        desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
        desktopPlatform: "win32",
      }),
    ).toBeUndefined();
  });

  it("exposes overlay Controller versions from Chat, Work and retained pins", () => {
    const versions = reviewedOverlayHookDesktopVersions();
    expect(versions).toContain(HISTORICAL_CPA_LIVE_VOICE_DESKTOP_VERSION);
    expect(versions).toContain(HASHED_WEBPACK_VOICE_VERSION);
    expect(versions).toContain("26.1021.31345");
    expect(versions).toEqual([...versions].sort());
  });

  it("hashes every consumer-relevant named Chat and Work field", () => {
    const chat = voiceProfileOwner("chat", "darwin", "26.1027.61615");
    const work = voiceProfileOwner("work", "darwin", "26.1027.61615");
    if (!chat || !work) throw new Error("missing named owners");
    expect(chat).toEqual(
      expect.objectContaining({
        kind: "named-chat",
        primary: expect.any(String),
        settings: expect.any(String),
        roles: expect.any(Object),
      }),
    );
    expect(work).toEqual(
      expect.objectContaining({
        kind: "named-work",
        init: "Adr",
        fetchFrom: "initial",
        services: "Vct",
        responseError: "Pdr",
        responseErrorFrom: "initial",
        capabilityInit: "Ler",
        capabilityFamily: "Ier",
        inferenceGateFamily: "Vfr",
      }),
    );
    const hashedChat = voiceProfileOwner("chat", "darwin", HASHED_WEBPACK_VOICE_VERSION);
    const hashedWork = voiceProfileOwner("work", "darwin", HASHED_WEBPACK_VOICE_VERSION);
    if (!hashedChat || !hashedWork) throw new Error("missing hashed owners");
    expect(digestJson({ ...hashedChat, start: "mutated" })).not.toBe(digestJson(hashedChat));
    expect(digestJson({ ...hashedWork, webpack: "mutated" })).not.toBe(digestJson(hashedWork));
    const digest = digestJson(chat);
    for (const field of ["primary", "settings", "start", "prewarm", "initial", "shared"] as const) {
      expect(digestJson({ ...chat, [field]: "mutated" })).not.toBe(digest);
    }
    const workDigest = digestJson(work);
    for (const field of [
      "init",
      "fetchFrom",
      "services",
      "responseError",
      "responseErrorFrom",
      "capabilityInit",
      "capabilityFamily",
      "inferenceGateFamily",
      "overlay",
      "fetch",
      "bridge",
    ] as const) {
      expect(digestJson({ ...work, [field]: "mutated" })).not.toBe(workDigest);
    }
  });

  it("emits an implementation revision without fabricating reviewed evidence", () => {
    const artifact = voiceQualificationArtifact();
    expect(artifact.implementationRevision).toBe(voiceImplementationRevision());
    expect(artifact.implementationRevision.length).toBe(16);
    expect(artifact.reviewedEvidence).toEqual([]);
  });
});
