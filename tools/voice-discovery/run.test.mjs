import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  interpretCandidateSource,
  interpretCandidateSources,
  reconcileSourceRecord,
} from "./source-inventory.mjs";
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

  it("does not treat unused object keys or unrelated .d/short-string calls as factory exports", () => {
    const records = interpretCandidateSources(
      `export const __webpack_modules__ = {
        decoy(e,t,n){
          const debug={dispatchVoiceCommand: helper, startVoiceWithIntroduction: other};
          other.d(exports,{initializeVoiceSession:()=>z});
          foo("OWtl");
        }
      };`,
      "decoy.js",
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].id, "decoy");
    assert.equal(records[0].exports.includes("dispatchVoiceCommand"), false);
    assert.equal(records[0].exports.includes("startVoiceWithIntroduction"), false);
    assert.equal(records[0].exports.includes("initializeVoiceSession"), false);
    assert.equal(records[0].imports.includes("OWtl"), false);
  });

  it("keeps factory identity when a chunk contains multiple webpack modules", () => {
    const records = interpretCandidateSources(
      `export const __webpack_modules__ = {
        j9r7(e,t,n){n.d(t,{initializeVoiceSession:()=>ag}); function ag(){ return {dispatchVoiceCommand:eQ,startVoiceWithIntroduction:tm}; } var l=n("OWtl");},
        oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>E}); function E(){}},
        decoy(e,t,n){ const debug={dispatchVoiceCommand: helper}; foo("Sd8U"); }
      };`,
      "530142.1e51e7f4b2.js",
    );
    const byId = Object.fromEntries(records.map((record) => [record.id, record]));
    assert.deepEqual(records.map((record) => record.id).sort(), ["decoy", "j9r7", "oWM3"]);
    assert.equal(byId.j9r7.exports.includes("initializeVoiceSession"), true);
    assert.equal(byId.j9r7.exports.includes("dispatchVoiceCommand"), true);
    assert.equal(byId.j9r7.exports.includes("startVoiceWithIntroduction"), true);
    assert.equal(byId.j9r7.exports.includes("VoiceInstantConnectCacheController"), false);
    assert.equal(byId.j9r7.imports.includes("OWtl"), true);
    assert.equal(byId.oWM3.exports.includes("VoiceInstantConnectCacheController"), true);
    assert.equal(byId.oWM3.exports.includes("initializeVoiceSession"), false);
    assert.equal(byId.decoy.exports.includes("dispatchVoiceCommand"), false);
    assert.equal(byId.decoy.imports.includes("Sd8U"), false);
  });

  it("traces session methods from exported initializeVoiceSession rather than arbitrary keys", () => {
    const records = interpretCandidateSources(
      `export const __webpack_modules__ = {
        j9r7(e,t,n){
          n.d(t,{initializeVoiceSession:()=>ag});
          const unused={dispatchVoiceCommand: helper};
          const au={dispatchVoiceCommand:eQ,startVoiceWithIntroduction:tm,createVoiceUploadOutcomeLogger:A};
          function ag(){ return i=i??Promise.resolve().then(()=>({...au,disposeVoiceSession:d})).catch(()=>{}); }
        }
      };`,
      "session.js",
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].id, "j9r7");
    assert.equal(records[0].exports.includes("initializeVoiceSession"), true);
    assert.equal(records[0].exports.includes("dispatchVoiceCommand"), true);
    assert.equal(records[0].exports.includes("startVoiceWithIntroduction"), true);
    assert.equal(records[0].exports.includes("disposeVoiceSession"), false);
    assert.equal(records[0].exports.includes("createVoiceUploadOutcomeLogger"), false);
    assert.equal(records[0].exports.includes("unused"), false);
  });

  it("does not take session methods from another exported helper", () => {
    const records = interpretCandidateSources(
      `export const __webpack_modules__ = {
        j9r7(e,t,n){
          n.d(t,{initializeVoiceSession:()=>ag,helper:()=>h});
          function ag(){ return Promise.resolve({ok:true}); }
          function h(){ return {dispatchVoiceCommand:eQ,startVoiceWithIntroduction:tm}; }
        }
      };`,
      "session-helper.js",
    );
    assert.equal(records[0].id, "j9r7");
    assert.equal(records[0].exports.includes("initializeVoiceSession"), true);
    assert.equal(records[0].exports.includes("helper"), true);
    assert.equal(records[0].exports.includes("dispatchVoiceCommand"), false);
    assert.equal(records[0].exports.includes("startVoiceWithIntroduction"), false);
  });

  it("traces hashed scope brands from export-owned z8 constructors", () => {
    const records = interpretCandidateSources(
      `export const __webpack_modules__ = {
        OWtl(e,t,n){let i=(0,n("Hl6a").z8)("AppScope"); n.d(t,{},{u:i});},
        Oj9r(e,t,n){var i=n("zTeN"); n.d(t,{GD:()=>y}); let y=(0,i.z8)("RouteScope",{retain:{max:20}});},
        Sd8U(e,t,n){var r=n("zTeN"),s=n("Oj9r"); let l=(0,r.z8)("ComposerScope",{parent:s.GD}); n.d(t,{},{PR:l});},
        unused(e,t,n){ const debug={AppScope:1}; z8("RouteScope"); foo("OWtl"); }
      };`,
      "scopes.js",
    );
    const byId = Object.fromEntries(records.map((record) => [record.id, record]));
    assert.equal(byId.OWtl.exports.includes("u"), true);
    assert.equal(byId.OWtl.brands.includes("AppScope"), true);
    assert.equal(byId.Oj9r.exports.includes("GD"), true);
    assert.equal(byId.Oj9r.brands.includes("RouteScope"), true);
    assert.equal(byId.Sd8U.exports.includes("PR"), true);
    assert.equal(byId.Sd8U.brands.includes("ComposerScope"), true);
    assert.equal(byId.Sd8U.imports.includes("Oj9r"), true);
    assert.equal(byId.unused.brands.includes("RouteScope"), false);
    assert.equal(byId.unused.exports.includes("AppScope"), false);
    assert.equal(byId.unused.imports.includes("OWtl"), false);
  });

  it("collapses duplicate copies of the same factory and keeps conflicting copies distinct", () => {
    const first = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>E}); var i=n("HWpc"); function E(){}}}`,
      "530142.js",
    );
    const duplicate = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>T}); var a=n("HWpc"); function T(){}}}`,
      "586788.js",
    );
    const conflicting = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>E,otherRole:()=>F}); var i=n("HWpc"); function E(){} function F(){}}}`,
      "other.js",
    );
    const requireTarget = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>E}); var i=n("HWpd"); function E(){}}}`,
      "require.js",
    );
    const literal = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>E}); var i=n("HWpc"); const k="other"; function E(){}}}`,
      "literal.js",
    );
    const controlFlow = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>E}); if(n)return; var i=n("HWpc"); function E(){}}}`,
      "flow.js",
    );
    assert.equal(first[0].id, "oWM3");
    assert.equal(duplicate[0].id, "oWM3");
    assert.equal(first[0].digest, duplicate[0].digest);
    assert.notEqual(first[0].digest, conflicting[0].digest);
    assert.notEqual(first[0].digest, requireTarget[0].digest);
    assert.notEqual(first[0].digest, literal[0].digest);
    assert.notEqual(first[0].digest, controlFlow[0].digest);
  });

  it("collapses local alpha-renames including destructuring aliases and keeps capture/shadowing distinct", () => {
    const destructured = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>E}); var i=n("HWpc"); function E(e){const {loadVoiceSession:M}=e; return M}}}`,
      "530142.js",
    );
    const renamed = interpretCandidateSources(
      `export const __webpack_modules__={oWM3(e,t,n){n.d(t,{VoiceInstantConnectCacheController:()=>T}); var a=n("HWpc"); function T(e){const {loadVoiceSession:V}=e; return V}}}`,
      "586788.js",
    );
    const capture = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){function inner(){ return e }}}`,
      "capture.js",
    );
    const localParam = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){function inner(e){ return e }}}`,
      "local.js",
    );
    const shadowed = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){function inner(){ let e=1; return e }}}`,
      "shadow.js",
    );
    const blockLet = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){ { let x=1; return x } }}`,
      "block.js",
    );
    const functionVar = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){ var x=1; { return x } }}`,
      "var.js",
    );
    const classBinder = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){ class C { m(){ return C } } }}`,
      "class.js",
    );
    const classRenamed = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){ class D { m(){ return D } } }}`,
      "class-renamed.js",
    );
    const catchBinder = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){ try {} catch(err){ return err } }}`,
      "catch.js",
    );
    const catchRenamed = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){ try {} catch(ex){ return ex } }}`,
      "catch-renamed.js",
    );
    const catchVsFactory = interpretCandidateSources(
      `export const __webpack_modules__={mod(e,t,n){ try {} catch(err){ return e } }}`,
      "catch-capture.js",
    );
    assert.equal(destructured[0].digest, renamed[0].digest);
    assert.notEqual(capture[0].digest, localParam[0].digest);
    assert.notEqual(capture[0].digest, shadowed[0].digest);
    assert.notEqual(localParam[0].digest, shadowed[0].digest);
    assert.notEqual(blockLet[0].digest, functionVar[0].digest);
    assert.equal(classBinder[0].digest, classRenamed[0].digest);
    assert.equal(catchBinder[0].digest, catchRenamed[0].digest);
    assert.notEqual(catchBinder[0].digest, catchVsFactory[0].digest);
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
