import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { voiceProfilePins } from "../../packages/renderer-extension/src/renderer-voice-profiles.ts";
import {
  loadCurrentSourceVoiceIdentity,
  parseVoiceProfilePins,
  parseVoiceQualification,
  voiceDistDirectory,
} from "../../scripts/release/voice-release-artifacts.mjs";

const root = path.resolve(import.meta.dirname, "../..");

describe("voice dist artifacts", () => {
  it("requires a current-source Renderer build whose baked identity matches the live dist", async () => {
    const identity = await loadCurrentSourceVoiceIdentity(root);
    const dist = voiceDistDirectory(root);
    const pinsText = await readFile(path.join(dist, "voice-profile-pins.json"), "utf8");
    const qualificationText = await readFile(path.join(dist, "voice-qualification.json"), "utf8");
    const distPins = parseVoiceProfilePins(pinsText);
    const distQualification = parseVoiceQualification(qualificationText);
    expect(identity.pins).toEqual(voiceProfilePins);
    expect(distPins).toEqual(identity.pins);
    expect(distQualification).toEqual(identity.qualification);
    expect(distQualification.reviewedEvidence).toEqual([]);
    expect(distQualification.implementationRevision).toBe(
      identity.qualification.implementationRevision,
    );
  });
});
