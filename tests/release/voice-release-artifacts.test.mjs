import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { expectedPayloadPaths } from "../../scripts/release/prepare-payload.mjs";
import { expectedNpmPackagePaths } from "../../scripts/release/prepare-npm.mjs";
import { releaseTarget } from "../../scripts/release/targets.mjs";
import { computeVoiceImplementationIdentity } from "../../packages/renderer-extension/scripts/voice-implementation-identity.mjs";
import { voiceProfilePins } from "../../packages/renderer-extension/src/renderer-voice-profiles.ts";
import {
  VOICE_QUALIFICATION_RELATIVE,
  VOICE_PROFILE_PINS_RELATIVE,
  parseVoiceProfilePins,
  parseVoiceQualification,
  stageAndValidateVoiceReleaseArtifacts,
  validateStagedVoiceArtifacts,
  voiceDistDirectory,
  voiceReleaseCopyPlan,
} from "../../scripts/release/voice-release-artifacts.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const pins = `${JSON.stringify({
  hashedVersion: "26.1106.51428",
  overlayHookDesktopVersions: ["26.1106.51428"],
})}\n`;
const qualification = `${JSON.stringify({
  implementationRevision: "abcd1234abcd1234",
  reviewedEvidence: [],
})}\n`;

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "codexhost-voice-artifacts-"));
}

describe("voice release artifacts", () => {
  it("copies generated pins and qualification into installer and npm app dirs", () => {
    expect(expectedPayloadPaths(releaseTarget("macos-arm64"))).toEqual(
      expect.arrayContaining([VOICE_PROFILE_PINS_RELATIVE, VOICE_QUALIFICATION_RELATIVE]),
    );
    expect(expectedNpmPackagePaths(releaseTarget("macos-arm64"))).toEqual(
      expect.arrayContaining([VOICE_PROFILE_PINS_RELATIVE, VOICE_QUALIFICATION_RELATIVE]),
    );
    const plan = voiceReleaseCopyPlan(root, path.join(root, "build", "payload", "app"));
    expect(plan.map((entry) => path.basename(entry.source))).toEqual([
      "voice-profile-pins.json",
      "voice-qualification.json",
    ]);
    expect(plan[0]?.source.startsWith(voiceDistDirectory(root))).toBe(true);
  });

  it("wires installer and npm packagers to stage-and-validate", async () => {
    const payload = await readFile(path.join(root, "scripts/release/prepare-payload.mjs"), "utf8");
    const npm = await readFile(path.join(root, "scripts/release/prepare-npm.mjs"), "utf8");
    expect(payload).toContain("stageAndValidateVoiceReleaseArtifacts");
    expect(npm).toContain("stageAndValidateVoiceReleaseArtifacts");
  });

  it("rejects missing, corrupt and stale staged artifacts", async () => {
    const source = await temporaryDirectory();
    const staged = await temporaryDirectory();
    try {
      await writeFile(path.join(source, "voice-profile-pins.json"), pins);
      await writeFile(path.join(source, "voice-qualification.json"), qualification);
      await expect(
        validateStagedVoiceArtifacts({ stagedAppDir: staged, sourceDistDir: source }),
      ).rejects.toThrow("staged payload is missing voice-profile-pins.json");

      await writeFile(path.join(staged, "voice-profile-pins.json"), "{");
      await writeFile(path.join(staged, "voice-qualification.json"), qualification);
      await expect(
        validateStagedVoiceArtifacts({ stagedAppDir: staged, sourceDistDir: source }),
      ).rejects.toThrow("voice profile pins are corrupt");

      await writeFile(path.join(staged, "voice-profile-pins.json"), pins);
      await writeFile(
        path.join(staged, "voice-qualification.json"),
        `${JSON.stringify({ implementationRevision: "stale-revision", reviewedEvidence: [] })}\n`,
      );
      await expect(
        validateStagedVoiceArtifacts({ stagedAppDir: staged, sourceDistDir: source }),
      ).rejects.toThrow("does not match the source Renderer build");
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  it("accepts staged artifacts that match an injected identity in no-build unit tests", async () => {
    const source = await temporaryDirectory();
    const staged = await temporaryDirectory();
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "voice-profile-pins.json"), pins);
      await writeFile(path.join(source, "voice-qualification.json"), qualification);
      await writeFile(path.join(staged, "voice-profile-pins.json"), pins);
      await writeFile(path.join(staged, "voice-qualification.json"), qualification);
      await expect(
        validateStagedVoiceArtifacts({
          stagedAppDir: staged,
          sourceDistDir: source,
          sourceIdentity: {
            pins: JSON.parse(pins),
            qualification: JSON.parse(qualification),
          },
        }),
      ).resolves.toBeUndefined();
      expect(parseVoiceProfilePins(pins).hashedVersion).toBe("26.1106.51428");
      expect(parseVoiceQualification(qualification).reviewedEvidence).toEqual([]);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  it("rejects skipBuild dummy artifacts against independently derived current-source identity", async () => {
    const staged = await temporaryDirectory();
    const graphRevision = await computeVoiceImplementationIdentity(
      path.join(root, "packages", "renderer-extension"),
    );
    const independentIdentity = {
      pins: voiceProfilePins,
      qualification: {
        implementationRevision: graphRevision,
        reviewedEvidence: [],
      },
    };
    try {
      await writeFile(path.join(staged, "voice-profile-pins.json"), pins);
      await writeFile(path.join(staged, "voice-qualification.json"), qualification);
      await expect(
        validateStagedVoiceArtifacts({
          stagedAppDir: staged,
          repositoryRoot: root,
          sourceIdentity: independentIdentity,
        }),
      ).rejects.toThrow(
        /does not match current source identity|does not match current implementation source graph/u,
      );
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });

  it("accepts temporary staged artifacts that match independently derived current-source identity", async () => {
    const staged = await temporaryDirectory();
    const source = await temporaryDirectory();
    const graphRevision = await computeVoiceImplementationIdentity(
      path.join(root, "packages", "renderer-extension"),
    );
    const independentIdentity = {
      pins: voiceProfilePins,
      qualification: {
        implementationRevision: graphRevision,
        reviewedEvidence: [],
      },
    };
    const pinsText = `${JSON.stringify(voiceProfilePins)}\n`;
    const qualificationText = `${JSON.stringify(independentIdentity.qualification)}\n`;
    try {
      await writeFile(path.join(source, "voice-profile-pins.json"), pinsText);
      await writeFile(path.join(source, "voice-qualification.json"), qualificationText);
      await writeFile(path.join(staged, "voice-profile-pins.json"), pinsText);
      await writeFile(path.join(staged, "voice-qualification.json"), qualificationText);
      await expect(
        validateStagedVoiceArtifacts({
          stagedAppDir: staged,
          sourceDistDir: source,
          repositoryRoot: root,
          sourceIdentity: independentIdentity,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  it("fails packager staging when generated JSON is missing", async () => {
    const repositoryRoot = await temporaryDirectory();
    const appDir = await temporaryDirectory();
    try {
      await expect(
        stageAndValidateVoiceReleaseArtifacts({
          repositoryRoot,
          appDir,
          copyFile: async (source) => {
            throw Object.assign(new Error(`missing ${source}`), { code: "ENOENT" });
          },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(appDir, { recursive: true, force: true });
    }
  });
});
