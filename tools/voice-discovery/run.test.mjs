import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { interpretCandidateSource, reconcileSourceRecord } from "./source-inventory.mjs";
import { parseArguments } from "./run.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("voice discovery orchestration", () => {
  it("requires an explicit inventory and never infers the installed app", () => {
    assert.throws(() => parseArguments([]), /specify --inventory or --replay/u);
    assert.deepEqual(parseArguments(["--inventory", "candidate.json"]), {
      inventoryPath: "candidate.json",
      replayPath: null,
      fingerprint: null,
    });
  });

  it("recovers semantic literals without depending on a minified identifier", () => {
    const interpreted = interpretCandidateSource(
      `function start(){ return initializeVoiceSession(); } export const brand = "AppScope"; const scope = { __scopeBrand: "RouteScope" };`,
      "fixture.js",
    );
    assert.equal(interpreted.literals.includes("AppScope"), true);
    assert.equal(interpreted.callees.includes("initializeVoiceSession"), true);
    assert.equal(interpreted.exports.includes("brand"), true);
    assert.equal(interpreted.brands.includes("RouteScope"), true);
    assert.equal("text" in interpreted, false);
    const decoy = interpretCandidateSource(
      `/* initializeVoiceSession */ const docs = "initializeVoiceSession";`,
      "decoy.js",
    );
    assert.equal(decoy.callees.includes("initializeVoiceSession"), false);
    assert.equal(decoy.exports.includes("initializeVoiceSession"), false);
  });

  it("rejects unrelated source bytes paired with spoofed role claims", () => {
    assert.throws(
      () =>
        reconcileSourceRecord({
          id: "decoy.js",
          path: "decoy.js",
          text: `/* initializeVoiceSession */ const docs = "AppScope";`,
          callees: ["initializeVoiceSession"],
          exports: ["initializeVoiceSession"],
          brands: ["VoiceInstantConnectCacheController"],
        }),
      /contradicts bytes-derived interpretation/u,
    );
  });

  it("labels replay descriptors without bytes as snapshot assertions", () => {
    const snapshot = reconcileSourceRecord({
      id: "start.renamed.js",
      path: "start.renamed.js",
      callees: ["startVoiceWithIntroduction"],
    });
    assert.equal(snapshot.interpretationProvenance, "snapshot-assertion");
    assert.equal("text" in snapshot, false);
  });
});

describe("voice discovery command", () => {
  it("maps a renamed new-version Chat layout from AST ownership, not known hashes", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "voice-discovery-"));
    try {
      const startFile = path.join(directory, "start.min.js");
      const prewarmFile = path.join(directory, "prewarm.min.js");
      const runtimeFile = path.join(directory, "runtime.min.js");
      const decoyFile = path.join(directory, "decoy.js");
      writeFileSync(
        startFile,
        `function a9(){ return startVoiceWithIntroduction(); } exports.q3 = a9;`,
      );
      writeFileSync(
        prewarmFile,
        `function z9(){} z9.displayName = "VoiceInstantConnectCacheController"; exports.k = z9;`,
      );
      writeFileSync(
        runtimeFile,
        `const scope = { __scopeBrand: "AppScope" }; const route = { __scopeBrand: "RouteScope" }; const composer = { displayName: "ComposerScope" };`,
      );
      writeFileSync(decoyFile, `/* initializeVoiceSession */ const docs = "AppScope";`);
      const inventory = path.join(directory, "inventory.json");
      writeFileSync(
        inventory,
        JSON.stringify({
          platform: "darwin",
          desktopVersion: "26.9999.1",
          desktopBuild: "1",
          assets: ["348410.renamed.js", "start.min.js", "prewarm.min.js"],
          files: [startFile, prewarmFile, runtimeFile, decoyFile],
        }),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(root, "tools/voice-discovery/run.mjs"), "--inventory", inventory],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.descriptor.kind, "semantic-chat");
      assert.equal(report.descriptor.activation, "candidate");
      assert.equal(report.descriptor.roles.start.includes("start.min.js"), true);
      assert.equal(report.descriptor.identity.interpretation, "bytes-verified");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prints a rejected candidate for partial assets without writing profiles", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "voice-discovery-"));
    try {
      const inventory = path.join(directory, "inventory.json");
      writeFileSync(
        inventory,
        JSON.stringify({
          platform: "darwin",
          desktopVersion: "26.1106.51428",
          assets: ["348410.1a97dde15f.js"],
        }),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(root, "tools/voice-discovery/run.mjs"), "--inventory", inventory],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.type, "voice-discovery");
      assert.equal(report.descriptor.activation, "rejected");
      assert.equal(report.descriptor.kind, "hashed-chat");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails when CLI JSON pairs unrelated bytes with spoofed roles", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "voice-discovery-"));
    try {
      const inventory = path.join(directory, "inventory.json");
      writeFileSync(
        inventory,
        JSON.stringify({
          platform: "darwin",
          desktopVersion: "26.9999.1",
          assets: ["start.min.js"],
          sources: [
            {
              id: "start.min.js",
              path: "start.min.js",
              text: `/* initializeVoiceSession */ const docs = "AppScope";`,
              callees: ["initializeVoiceSession"],
              exports: ["initializeVoiceSession"],
              brands: ["VoiceInstantConnectCacheController"],
            },
          ],
        }),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(root, "tools/voice-discovery/run.mjs"), "--inventory", inventory],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /contradicts bytes-derived interpretation/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("labels CLI replay JSON without bytes as snapshot assertions", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "voice-discovery-"));
    try {
      const inventory = path.join(directory, "inventory.json");
      writeFileSync(
        inventory,
        JSON.stringify({
          platform: "darwin",
          desktopVersion: "26.9999.1",
          assets: ["start.renamed.js", "prewarm.renamed.js", "runtime.renamed.js"],
          sources: [
            {
              id: "start.renamed.js",
              path: "chunks/start.renamed.js",
              callees: ["startVoiceWithIntroduction"],
              exports: ["q3"],
            },
            {
              id: "prewarm.renamed.js",
              path: "chunks/prewarm.renamed.js",
              exports: ["z9"],
              brands: ["VoiceInstantConnectCacheController"],
            },
            {
              id: "runtime.renamed.js",
              path: "chunks/runtime.renamed.js",
              brands: ["AppScope", "RouteScope", "ComposerScope"],
            },
          ],
        }),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(root, "tools/voice-discovery/run.mjs"), "--inventory", inventory],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.descriptor.kind, "semantic-chat");
      assert.equal(report.descriptor.identity.interpretation, "snapshot-assertion");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails visibly when the renderer discovery module is missing", () => {
    const missing = path.join(os.tmpdir(), "missing-voice-discovery.js");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "tools/voice-discovery/run.mjs"), "--inventory", "candidate.json"],
      {
        encoding: "utf8",
        env: { ...process.env, CODEXHOST_VOICE_DISCOVERY_MODULE: missing },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /voice-discovery requires/u);
    assert.match(result.stderr, /build:renderer/u);
  });
});
