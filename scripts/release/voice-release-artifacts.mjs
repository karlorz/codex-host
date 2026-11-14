import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { computeVoiceImplementationIdentity } from "../../packages/renderer-extension/scripts/voice-implementation-identity.mjs";

export const VOICE_PROFILE_PINS_RELATIVE = "app/voice-profile-pins.json";
export const VOICE_QUALIFICATION_RELATIVE = "app/voice-qualification.json";
export const VOICE_RELEASE_ARTIFACT_PATHS = [
  VOICE_PROFILE_PINS_RELATIVE,
  VOICE_QUALIFICATION_RELATIVE,
];

export function voiceDistDirectory(repositoryRoot) {
  return path.join(repositoryRoot, "packages", "renderer-extension", "dist");
}

export function voiceReleaseCopyPlan(repositoryRoot, appDir) {
  const dist = voiceDistDirectory(repositoryRoot);
  return [
    {
      source: path.join(dist, "voice-profile-pins.json"),
      destination: path.join(appDir, "voice-profile-pins.json"),
      label: "voice profile pins",
    },
    {
      source: path.join(dist, "voice-qualification.json"),
      destination: path.join(appDir, "voice-qualification.json"),
      label: "voice qualification artifact",
    },
  ];
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function parseVoiceProfilePins(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("voice profile pins are corrupt");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !isNonEmptyString(parsed.hashedVersion) ||
    !Array.isArray(parsed.overlayHookDesktopVersions) ||
    parsed.overlayHookDesktopVersions.some((version) => !isNonEmptyString(version))
  ) {
    throw new Error("voice profile pins are missing required identity fields");
  }
  return parsed;
}

export function parseVoiceQualification(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("voice qualification artifact is corrupt");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !isNonEmptyString(parsed.implementationRevision) ||
    !Array.isArray(parsed.reviewedEvidence)
  ) {
    throw new Error("voice qualification artifact is missing required identity fields");
  }
  return parsed;
}

function canonicalize(value) {
  return `${JSON.stringify(value)}\n`;
}

async function readStagedVoiceFile(stagedAppDir, name, parse) {
  const stagedPath = path.join(stagedAppDir, name);
  let stagedText;
  try {
    stagedText = await readFile(stagedPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`staged payload is missing ${name}`, { cause: error });
    }
    throw error;
  }
  return { text: stagedText, parsed: parse(stagedText) };
}

export async function loadCurrentSourceVoiceIdentity(repositoryRoot) {
  const { build } = await import("esbuild");
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-voice-identity-"));
  const outfile = path.join(directory, "voice-profiles.mjs");
  try {
    await build({
      absWorkingDir: path.join(repositoryRoot, "packages", "renderer-extension"),
      entryPoints: ["src/renderer-voice-profiles.ts"],
      bundle: true,
      platform: "neutral",
      format: "esm",
      outfile,
      logLevel: "silent",
    });
    const module_ = await import(pathToFileURL(outfile).href);
    const qualification = module_.voiceQualificationArtifact();
    const implementationRevision = await computeVoiceImplementationIdentity(
      path.join(repositoryRoot, "packages", "renderer-extension"),
    );
    if (qualification.implementationRevision !== implementationRevision) {
      throw new Error(
        "baked voice implementation revision does not match current implementation source graph",
      );
    }
    return {
      pins: module_.voiceProfilePins,
      qualification,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function validateStagedVoiceArtifacts({
  stagedAppDir,
  sourceDistDir,
  repositoryRoot,
  sourceIdentity,
}) {
  const pins = await readStagedVoiceFile(
    stagedAppDir,
    "voice-profile-pins.json",
    parseVoiceProfilePins,
  );
  const qualification = await readStagedVoiceFile(
    stagedAppDir,
    "voice-qualification.json",
    parseVoiceQualification,
  );
  const identity =
    sourceIdentity ??
    (repositoryRoot ? await loadCurrentSourceVoiceIdentity(repositoryRoot) : undefined);
  if (identity) {
    if (canonicalize(pins.parsed) !== canonicalize(identity.pins)) {
      throw new Error("staged voice-profile-pins.json does not match current source identity");
    }
    if (canonicalize(qualification.parsed) !== canonicalize(identity.qualification)) {
      throw new Error("staged voice-qualification.json does not match current source identity");
    }
  }
  if (repositoryRoot) {
    const implementationRevision = await computeVoiceImplementationIdentity(
      path.join(repositoryRoot, "packages", "renderer-extension"),
    );
    if (qualification.parsed.implementationRevision !== implementationRevision) {
      throw new Error(
        "staged voice-qualification.json implementationRevision does not match current implementation source graph",
      );
    }
  }
  if (!sourceDistDir) return;
  for (const file of [
    { name: "voice-profile-pins.json", parse: parseVoiceProfilePins, staged: pins },
    { name: "voice-qualification.json", parse: parseVoiceQualification, staged: qualification },
  ]) {
    let sourceText;
    try {
      sourceText = await readFile(path.join(sourceDistDir, file.name), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(`source build is missing ${file.name}`, { cause: error });
      }
      throw error;
    }
    file.parse(sourceText);
    if (file.staged.text !== sourceText) {
      throw new Error(`staged ${file.name} does not match the source Renderer build`);
    }
  }
}

export async function stageAndValidateVoiceReleaseArtifacts({
  repositoryRoot,
  appDir,
  copyFile,
  sourceIdentity,
}) {
  for (const artifact of voiceReleaseCopyPlan(repositoryRoot, appDir)) {
    await copyFile(artifact.source, artifact.destination, artifact.label);
  }
  await validateStagedVoiceArtifacts({
    stagedAppDir: appDir,
    sourceDistDir: voiceDistDirectory(repositoryRoot),
    repositoryRoot,
    sourceIdentity,
  });
}
