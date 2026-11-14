#!/usr/bin/env node
/**
 * Maintainer voice candidate analysis. Reads an explicit inventory or bundle
 * files. Never modifies the installed official app or activates a profile.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { readCandidateInventory, reconcileCandidateInventory } from "./source-inventory.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function usage() {
  process.stderr.write(`usage:
  node tools/voice-discovery/run.mjs --inventory <json-file>
  node tools/voice-discovery/run.mjs --replay <json-file> --fingerprint <hex>

The command prints a candidate descriptor. Structural similarity is not a
behavioral guarantee and never activates a profile.
`);
}

function parseArguments(argv) {
  const options = { inventoryPath: null, replayPath: null, fingerprint: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    switch (argument) {
      case "--inventory":
        options.inventoryPath = value();
        break;
      case "--replay":
        options.replayPath = value();
        break;
      case "--fingerprint":
        options.fingerprint = value();
        break;
      case "--help":
        usage();
        process.exitCode = 0;
        return null;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.inventoryPath && !options.replayPath) {
    throw new Error("specify --inventory or --replay");
  }
  if (options.replayPath && !options.fingerprint) {
    throw new Error("--replay requires --fingerprint");
  }
  return options;
}

function discoveryModulePath() {
  const override = process.env.CODEXHOST_VOICE_DISCOVERY_MODULE?.trim();
  return (
    override || path.join(repositoryRoot, "packages/renderer-extension/dist/voice-discovery.js")
  );
}

async function loadDiscovery() {
  const modulePath = discoveryModulePath();
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `voice-discovery requires ${modulePath}; run npm run build:renderer first (${detail})`,
      { cause: error },
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  const { discoverVoiceCandidate, fingerprintVoiceInventory, replayVoiceDiscovery } =
    await loadDiscovery();
  const sourcePath = options.inventoryPath ?? options.replayPath;
  const parsed = JSON.parse(await readFile(sourcePath, "utf8"));
  const inventory = reconcileCandidateInventory(
    parsed.files
      ? await readCandidateInventory(parsed)
      : {
          platform: parsed.platform,
          desktopVersion: parsed.desktopVersion,
          desktopBuild: parsed.desktopBuild,
          bundleDigest: parsed.bundleDigest,
          asarDigest: parsed.asarDigest,
          assets: parsed.assets ?? [],
          moduleIds: parsed.moduleIds ?? [],
          sources: parsed.sources ?? [],
        },
  );
  const fingerprint = fingerprintVoiceInventory(inventory);
  const descriptor = options.fingerprint
    ? replayVoiceDiscovery(inventory, options.fingerprint)
    : discoverVoiceCandidate({ ...inventory, fingerprint });
  process.stdout.write(
    `${JSON.stringify({ type: "voice-discovery", fingerprint, descriptor }, null, 2)}\n`,
  );
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments };
