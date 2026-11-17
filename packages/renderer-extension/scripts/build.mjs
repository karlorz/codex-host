import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { tailwindEsbuildPlugin } from "./tailwind-esbuild-plugin.mjs";
import { writeVoiceImplementationRevision } from "./voice-implementation-identity.mjs";
import {
  loadVoiceQualificationArtifact,
  requireAcceptedVoiceActivations,
} from "./voice-qualification-artifact.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
await writeVoiceImplementationRevision(packageRoot);
const entries = [
  { entry: "src/renderer-voice-profiles.ts", format: "esm", outfile: "dist/voice-profiles.js" },
  { entry: "src/renderer-voice-discovery.ts", format: "esm", outfile: "dist/voice-discovery.js" },
  { entry: "src/renderer-voice-evidence.ts", format: "esm", outfile: "dist/voice-evidence.js" },
  { entry: "src/index.ts", format: "esm", outfile: "dist/index.js" },
  { entry: "src/production-entry.ts", format: "iife", outfile: "dist/production.js" },
  { entry: "src/cpa-live-voice-entry.ts", format: "iife", outfile: "dist/cpa-live-voice-hook.js" },
  {
    entry: "src/overlay-voice-bootstrap-entry.ts",
    format: "iife",
    outfile: "dist/overlay-voice-bootstrap.js",
  },
  {
    entry: "src/hashed-native-chat-voice-entry.ts",
    format: "iife",
    outfile: "dist/hashed-native-chat-voice.js",
  },
  { entry: "src/probe-entry.ts", format: "iife", outfile: "dist/renderer-binding-probe.js" },
  { entry: "src/audit-entry.ts", format: "iife", outfile: "dist/contract-audit.js" },
  { entry: "src/console-entry.ts", format: "iife", outfile: "dist/console.js" },
  { entry: "src/web-settings-entry.ts", format: "iife", outfile: "dist/web-settings.js" },
];

for (const { entry, format, outfile } of entries) {
  await build({
    absWorkingDir: packageRoot,
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format,
    target: "es2024",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
    plugins: [tailwindEsbuildPlugin()],
    outfile,
  });
}

const profilesUrl = pathToFileURL(path.join(packageRoot, "dist/voice-profiles.js")).href;
const profiles = await import(profilesUrl);
const evaluator = await import(
  pathToFileURL(path.join(packageRoot, "dist/voice-evidence.js")).href
);
await writeFile(
  path.join(packageRoot, "dist/voice-profile-pins.json"),
  `${JSON.stringify(profiles.voiceProfilePins, null, 2)}\n`,
);
const qualification = await loadVoiceQualificationArtifact(packageRoot, profiles, evaluator);
requireAcceptedVoiceActivations(qualification);
await writeFile(
  path.join(packageRoot, "dist/voice-qualification.json"),
  `${JSON.stringify(qualification, null, 2)}\n`,
);
