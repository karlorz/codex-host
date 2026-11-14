import {
  type VoiceEvidencePath,
  type VoiceEvidenceRecord,
} from "../src/renderer-voice-evidence.js";
import {
  profileIdentityKey,
  voiceImplementationRevision,
  voiceProfileDigest,
} from "../src/renderer-voice-profiles.js";

export const TEST_REVIEWED_NATIVE_BUILD = "26605";
export const TEST_REVIEWED_ASAR_DIGEST = `sha256:${"ab".repeat(32)}`;

export function hashedVoiceTestIdentity(): {
  desktopBuild: string;
  asarDigest: string;
  implementationRevision: string;
} {
  return {
    desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
    asarDigest: TEST_REVIEWED_ASAR_DIGEST,
    implementationRevision: voiceImplementationRevision(),
  };
}

export function reviewedVoiceEvidenceRecord(input: {
  path: VoiceEvidencePath;
  desktopPlatform: string;
  desktopVersion: string;
  desktopBuild?: string;
  asarDigest?: string;
  implementationRevision?: string;
}): VoiceEvidenceRecord {
  const product = input.path === "chat" ? "chat" : "work";
  const profileDigest = voiceProfileDigest(product, input.desktopPlatform, input.desktopVersion);
  if (!profileDigest) {
    throw new Error("reviewed evidence requires a known profile digest");
  }
  const identity = hashedVoiceTestIdentity();
  const record: VoiceEvidenceRecord = {
    profileKey: profileIdentityKey(product, input.desktopPlatform, input.desktopVersion),
    platform: input.desktopPlatform,
    desktopVersion: input.desktopVersion,
    path: input.path,
    implementationRevision: input.implementationRevision ?? identity.implementationRevision,
    profileDigest,
    policy: "reviewed",
    desktopBuild: input.desktopBuild ?? identity.desktopBuild,
    asarDigest: input.asarDigest ?? identity.asarDigest,
    stages: {
      structural: true,
      activation: true,
      connection: true,
      identity: true,
      speech: true,
      cleanup: true,
    },
    startAcknowledged: true,
    connected: true,
    conversationMatched: true,
    harnessMatched: true,
    speech: {
      attended: true,
      bothDirections: true,
      witness: "operator",
      run: "fixture",
    },
    cleanup: { ended: true, microphoneReleased: true },
  };
  if (input.path !== "chat") record.gatewayOwned = true;
  return record;
}

export function attachReviewedVoiceEvidence(
  config: Record<string, unknown>,
  paths: VoiceEvidencePath[],
): void {
  const platform = typeof config.desktopPlatform === "string" ? config.desktopPlatform : "darwin";
  const version = typeof config.desktopVersion === "string" ? config.desktopVersion : "";
  Object.assign(config, hashedVoiceTestIdentity());
  config.voiceEvidence = paths.map((path) =>
    reviewedVoiceEvidenceRecord({
      path,
      desktopPlatform: platform,
      desktopVersion: version,
    }),
  );
}
