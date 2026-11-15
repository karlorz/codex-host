import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import sharedConfig, { VOICE_DIST_ARTIFACT_TEST_GLOB } from "../vitest.config.js";
import voiceDistConfig from "../vitest.voice-dist.config.js";

const root = path.resolve(import.meta.dirname, "../..");

describe("voice dist artifact test entry point", () => {
  it("keeps live-dist identity out of the shared TypeScript suite", () => {
    expect(sharedConfig.test.exclude).toContain(VOICE_DIST_ARTIFACT_TEST_GLOB);
    expect(voiceDistConfig.test.exclude).not.toContain(VOICE_DIST_ARTIFACT_TEST_GLOB);
    expect(voiceDistConfig.test.include).toEqual([VOICE_DIST_ARTIFACT_TEST_GLOB]);
  });

  it("points package and Linux CI commands at the dedicated config", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    expect(pkg.scripts["test:voice-dist-artifacts"]).toContain(
      "vitest run --config tests/vitest.voice-dist.config.js",
    );
    expect(pkg.scripts["test:voice-dist-artifacts"]).not.toContain("tests/vitest.config.js");
    expect(ci).toMatch(/npx vitest run --config tests\/vitest\.voice-dist\.config\.js/);
    expect(ci).not.toMatch(
      /npx vitest run --config tests\/vitest\.config\.js tests\/release\/voice-release-artifacts\.dist\.test\.mjs/,
    );
  });

  it("keeps node:test voice-discovery out of the shared TypeScript suite", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(sharedConfig.test.exclude).toContain("tools/voice-discovery/**");
    expect(pkg.scripts["voice:discovery:test"]).toBe(
      "node --test tools/voice-discovery/run.test.mjs",
    );
  });
});
