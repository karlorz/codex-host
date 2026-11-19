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

  it.each([
    [
      "src/renderer-voice-starter-core.ts",
      "return workGateway || externalHarness;",
      "return false;",
    ],
    [
      "src/renderer-voice-capability-subscriptions.ts",
      'const ALLOWED_ACCESS = { status: "allowed" }',
      'const ALLOWED_ACCESS = { status: "denied" }',
    ],
    ["src/renderer-voice-routes-cache.ts", 'routes.workConnection === "gateway"', "false"],
  ])(
    "hashes behavior in multiline runtime imports and re-exports for %s",
    async (relative, from, to) => {
      expect(await listVoiceImplementationSourceFiles(packageRoot)).toContain(relative);
      const source = await readFile(path.join(packageRoot, relative), "utf8");
      expect(source).toContain(from);
      const before = await computeVoiceImplementationIdentity(packageRoot);
      expect(
        await computeVoiceImplementationIdentity(packageRoot, {
          [relative]: source.replace(from, to),
        }),
      ).not.toBe(before);
    },
  );

  it("follows multiline re-exports and skips type-only module edges", async () => {
    const relative = "src/renderer-voice-start-capability.ts";
    const replacements = {
      [relative]: `export {\n value,\n} from "./runtime-edge.js";\nimport type { Value } from "./type-edge.js";\nexport type { Other } from "./type-export-edge.js";`,
      "src/runtime-edge.ts": "export const value = true;",
    };
    const files = await listVoiceImplementationSourceFiles(packageRoot, replacements);
    expect(files).toContain("src/runtime-edge.ts");
    expect(files).not.toContain("src/type-edge.ts");
    expect(files).not.toContain("src/type-export-edge.ts");
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
