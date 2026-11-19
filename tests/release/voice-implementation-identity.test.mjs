import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GENERATED_REVISION_RELATIVE,
  VOICE_IMPLEMENTATION_SOURCE_FILES,
  computeVoiceImplementationIdentity,
  listVoiceImplementationSourceFiles,
} from "../../packages/renderer-extension/scripts/voice-implementation-identity.mjs";
import { voiceImplementationRevision } from "../../packages/renderer-extension/src/renderer-voice-profiles.ts";
import { evaluateVoiceEvidence } from "../../packages/renderer-extension/src/renderer-voice-evidence.ts";
import { reviewedVoiceEvidenceRecord } from "../../packages/renderer-extension/test/voice-evidence-fixture.ts";

const packageRoot = path.resolve(import.meta.dirname, "../../packages/renderer-extension");

describe("voice implementation identity", () => {
  it("is reproducible and excludes the generated revision file", async () => {
    expect(VOICE_IMPLEMENTATION_SOURCE_FILES).not.toContain(GENERATED_REVISION_RELATIVE);
    const files = await listVoiceImplementationSourceFiles(packageRoot);
    expect(files).not.toContain(GENERATED_REVISION_RELATIVE);
    expect(files).toContain("src/renderer-voice-assets.ts");
    expect(files).toContain("src/renderer-chat-voice-debug.ts");
    expect(files).toContain("src/overlay-voice-bootstrap-entry.ts");
  });

  it("changes when omitted asset-selection source changes", async () => {
    const first = await computeVoiceImplementationIdentity(packageRoot);
    const assetsPath = "src/renderer-voice-assets.ts";
    const assets = await readFile(path.join(packageRoot, assetsPath), "utf8");
    const assetsChanged = await computeVoiceImplementationIdentity(packageRoot, {
      [assetsPath]: `${assets}\n`,
    });
    expect(assetsChanged).not.toBe(first);
    const current = reviewedVoiceEvidenceRecord({
      path: "chat",
      desktopPlatform: "darwin",
      desktopVersion: "26.1106.51428",
      implementationRevision: first,
    });
    const stale = reviewedVoiceEvidenceRecord({
      path: "chat",
      desktopPlatform: "darwin",
      desktopVersion: "26.1106.51428",
      implementationRevision: assetsChanged,
    });
    expect(evaluateVoiceEvidence(stale).reason).toBe("implementation-revision-mismatch");
    expect(evaluateVoiceEvidence(current).qualified).toBe(true);
  });

  it("changes when runtime or evaluator source changes with unchanged profiles", async () => {
    const first = await computeVoiceImplementationIdentity(packageRoot);
    const second = await computeVoiceImplementationIdentity(packageRoot);
    expect(first).toBe(second);
    expect(first).toBe(voiceImplementationRevision());

    const runtimePath = "src/renderer-native-chat-voice-runtime.ts";
    const evidencePath = "src/renderer-voice-evidence.ts";
    const runtime = await readFile(path.join(packageRoot, runtimePath), "utf8");
    const evidence = await readFile(path.join(packageRoot, evidencePath), "utf8");
    const runtimeChanged = await computeVoiceImplementationIdentity(packageRoot, {
      [runtimePath]: `${runtime}\n`,
    });
    const evidenceChanged = await computeVoiceImplementationIdentity(packageRoot, {
      [evidencePath]: `${evidence}\n`,
    });
    expect(runtimeChanged).not.toBe(first);
    expect(evidenceChanged).not.toBe(first);
    expect(runtimeChanged).not.toBe(evidenceChanged);

    const current = reviewedVoiceEvidenceRecord({
      path: "chat",
      desktopPlatform: "darwin",
      desktopVersion: "26.1106.51428",
      implementationRevision: first,
    });
    const stale = reviewedVoiceEvidenceRecord({
      path: "chat",
      desktopPlatform: "darwin",
      desktopVersion: "26.1106.51428",
      implementationRevision: "deadbeefdeadbeef",
    });
    expect(evaluateVoiceEvidence(stale).reason).toBe("implementation-revision-mismatch");
    expect(evaluateVoiceEvidence(current).qualified).toBe(true);
  });
});
