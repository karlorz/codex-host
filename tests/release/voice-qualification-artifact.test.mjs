import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as profiles from "../../packages/renderer-extension/src/renderer-voice-profiles.ts";
import * as evaluator from "../../packages/renderer-extension/src/renderer-voice-evidence.ts";
import { reviewedVoiceEvidenceRecord } from "../../packages/renderer-extension/test/voice-evidence-fixture.ts";
import {
  VOICE_REVIEWED_EVIDENCE_RELATIVE,
  loadVoiceQualificationArtifact,
  requireAcceptedVoiceActivations,
} from "../../packages/renderer-extension/scripts/voice-qualification-artifact.mjs";
import {
  computeVoiceImplementationIdentity,
  listVoiceImplementationSourceFiles,
} from "../../packages/renderer-extension/scripts/voice-implementation-identity.mjs";
import {
  loadCurrentSourceVoiceIdentity,
  stageAndValidateVoiceReleaseArtifacts,
  validateStagedVoiceArtifacts,
} from "../../scripts/release/voice-release-artifacts.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../../packages/renderer-extension");

describe("reviewed voice evidence data", () => {
  it("rejects release staging of an otherwise matching build with cleared activation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voice-retained-activation-"));
    try {
      const fixtureRoot = path.join(directory, "packages/renderer-extension");
      const dist = path.join(fixtureRoot, "dist");
      const appDir = path.join(directory, "app");
      await mkdir(dist, { recursive: true });
      await mkdir(appDir);
      await symlink(
        path.join(packageRoot, "src"),
        path.join(fixtureRoot, "src"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const qualification = await loadVoiceQualificationArtifact(packageRoot, profiles, evaluator);
      const cleared = { ...qualification, reviewedEvidence: [] };
      await writeFile(
        path.join(dist, "voice-profile-pins.json"),
        JSON.stringify(profiles.voiceProfilePins),
      );
      await writeFile(path.join(dist, "voice-qualification.json"), JSON.stringify(cleared));
      await expect(
        stageAndValidateVoiceReleaseArtifacts({
          repositoryRoot: directory,
          appDir,
          copyFile: (source, destination) => copyFile(source, destination),
          sourceIdentity: { pins: profiles.voiceProfilePins, qualification: cleared },
        }),
      ).rejects.toThrow("packaging would drop accepted macOS voice activation");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks packaging when any accepted macOS voice path would disappear", async () => {
    const qualification = await loadVoiceQualificationArtifact(packageRoot, profiles, evaluator);
    expect(() => requireAcceptedVoiceActivations(qualification)).not.toThrow();
    expect(() =>
      requireAcceptedVoiceActivations({ ...qualification, reviewedEvidence: [] }),
    ).toThrow("packaging would drop accepted macOS voice activation");
    for (const path of ["chat", "work-codex", "work-grok"]) {
      expect(() =>
        requireAcceptedVoiceActivations({
          ...qualification,
          reviewedEvidence: qualification.reviewedEvidence.filter((record) => record.path !== path),
        }),
      ).toThrow(`packaging would drop accepted macOS voice activation: ${path}`);
    }
  });

  it("enables only the reviewed installed macOS identity for all three accepted paths", async () => {
    const artifact = await loadVoiceQualificationArtifact(packageRoot, profiles, evaluator);
    expect(artifact.reviewedEvidence.map((record) => record.path)).toEqual([
      "chat",
      "work-codex",
      "work-grok",
    ]);
    const record = artifact.reviewedEvidence[0];
    const config = {
      desktopPlatform: record.platform,
      desktopVersion: record.desktopVersion,
      desktopBuild: record.desktopBuild,
      asarDigest: record.asarDigest,
      implementationRevision: artifact.implementationRevision,
      voiceEvidence: artifact.reviewedEvidence,
    };
    for (const lane of ["chat", "work-codex", "work-grok"]) {
      expect(evaluator.startupVoiceGate(config)[lane]).toEqual({
        enabled: true,
        policy: "reviewed",
      });
      for (const mismatch of [
        { desktopPlatform: "win32" },
        { desktopVersion: "different-version" },
        { desktopBuild: "different-build" },
        { asarDigest: "different-archive" },
        { implementationRevision: "different-implementation" },
      ]) {
        expect(evaluator.startupVoiceGate({ ...config, ...mismatch })[lane].enabled).toBe(false);
      }
    }
    expect(artifact.reviewedEvidence.map((entry) => entry.speech.implementationRevision)).toEqual([
      "5f84eb365e1b6736",
      "f6f9c208ad38f922",
      "5f84eb365e1b6736",
    ]);
  });

  it("requires scoped provenance when carrying an attended result to a compatible revision", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voice-compatible-evidence-"));
    try {
      const file = path.join(directory, VOICE_REVIEWED_EVIDENCE_RELATIVE);
      const record = reviewedVoiceEvidenceRecord({
        path: "chat",
        desktopPlatform: "darwin",
        desktopVersion: "26.1106.51428",
      });
      record.testedImplementationRevision = "prior-tested-revision";
      record.speech.implementationRevision = record.testedImplementationRevision;
      await writeFile(file, JSON.stringify([record]));
      await expect(loadVoiceQualificationArtifact(directory, profiles, evaluator)).rejects.toThrow(
        "matching scoped compatibility review",
      );
      record.compatibilityReview = {
        ...Object.fromEntries(
          ["path", "platform", "desktopVersion", "desktopBuild", "asarDigest"].map((key) => [
            key,
            record[key],
          ]),
        ),
        testedImplementationRevision: record.testedImplementationRevision,
        implementationRevision: record.implementationRevision,
        reference: "test compatibility review",
        basis: "The executed platform path is unchanged.",
      };
      await writeFile(file, JSON.stringify([record]));
      const artifact = await loadVoiceQualificationArtifact(directory, profiles, evaluator);
      expect(artifact.reviewedEvidence[0].speech.implementationRevision).toBe(
        "prior-tested-revision",
      );
      record.compatibilityReview.platform = "win32";
      await writeFile(file, JSON.stringify([record]));
      await expect(loadVoiceQualificationArtifact(directory, profiles, evaluator)).rejects.toThrow(
        "matching scoped compatibility review",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("derives release evidence from reviewed source data and rejects staged substitutions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voice-reviewed-release-"));
    try {
      const fixtureRoot = path.join(directory, "packages/renderer-extension");
      await mkdir(fixtureRoot, { recursive: true });
      await symlink(
        path.join(packageRoot, "src"),
        path.join(fixtureRoot, "src"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const record = reviewedVoiceEvidenceRecord({
        path: "chat",
        desktopPlatform: "darwin",
        desktopVersion: "26.1106.51428",
      });
      await writeFile(
        path.join(fixtureRoot, VOICE_REVIEWED_EVIDENCE_RELATIVE),
        JSON.stringify([record]),
      );
      const identity = await loadCurrentSourceVoiceIdentity(directory);
      expect(identity.qualification.reviewedEvidence).toEqual([record]);
      const staged = path.join(directory, "staged");
      await mkdir(staged);
      await writeFile(path.join(staged, "voice-profile-pins.json"), JSON.stringify(identity.pins));
      await writeFile(
        path.join(staged, "voice-qualification.json"),
        JSON.stringify(identity.qualification),
      );
      await expect(
        validateStagedVoiceArtifacts({ stagedAppDir: staged, repositoryRoot: directory }),
      ).resolves.toBeUndefined();
      await writeFile(
        path.join(staged, "voice-qualification.json"),
        JSON.stringify({ ...identity.qualification, reviewedEvidence: [] }),
      );
      await expect(
        validateStagedVoiceArtifacts({ stagedAppDir: staged, repositoryRoot: directory }),
      ).rejects.toThrow("does not match current source identity");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("can add qualified observations without changing the implementation revision", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voice-reviewed-evidence-"));
    try {
      const file = path.join(directory, VOICE_REVIEWED_EVIDENCE_RELATIVE);
      await writeFile(file, "[]\n");
      const empty = await loadVoiceQualificationArtifact(directory, profiles, evaluator);
      const record = reviewedVoiceEvidenceRecord({
        path: "chat",
        desktopPlatform: "darwin",
        desktopVersion: "26.1106.51428",
      });
      const data = JSON.stringify([record]);
      await writeFile(file, data);
      const reviewed = await loadVoiceQualificationArtifact(directory, profiles, evaluator);
      expect(empty.reviewedEvidence).toEqual([]);
      expect(reviewed.reviewedEvidence).toEqual([record]);
      expect(reviewed.implementationRevision).toBe(empty.implementationRevision);
      expect(await listVoiceImplementationSourceFiles(packageRoot)).not.toContain(
        VOICE_REVIEWED_EVIDENCE_RELATIVE,
      );
      expect(
        await computeVoiceImplementationIdentity(packageRoot, {
          [VOICE_REVIEWED_EVIDENCE_RELATIVE]: data,
        }),
      ).toBe(await computeVoiceImplementationIdentity(packageRoot));

      for (const evidence of [
        [{ ...record, implementationRevision: "stale-revision" }],
        [{ ...record, connected: false }],
        [{ ...record, speech: { attended: false, bothDirections: false } }],
        [{ ...record, policy: "legacy-retained" }],
        [{}],
        {},
      ]) {
        await writeFile(file, JSON.stringify(evidence));
        await expect(
          loadVoiceQualificationArtifact(directory, profiles, evaluator),
        ).rejects.toThrow(/reviewed voice evidence/u);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
