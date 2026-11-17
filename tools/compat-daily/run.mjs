#!/usr/bin/env node
/**
 * macOS ChatGPT/Codex Desktop pin check. Fetches the public Sparkle appcast
 * and compares it to validated voice monitoring baselines. Does not download the .app zip.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function capture(source, pattern, label) {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Missing ${label}`);
  return match[1];
}

function optionalCapture(source, pattern) {
  return source.match(pattern)?.[1];
}

function pinsFromOwnerObject(source) {
  const block = source.match(/export const VOICE_PROFILE_PINS = \{([\s\S]*?)\n\} as const;/u)?.[1];
  if (!block) return undefined;
  const field = (name) => optionalCapture(block, new RegExp(`${name}: "([^"]+)"`, "u"));
  const workVersion = field("workVersion");
  const workInitial = field("workInitial");
  const chatStart = field("chatStart");
  if (!workVersion || !workInitial || !chatStart) return undefined;
  return {
    workVersion,
    workInitial,
    workShared:
      field("workShared") ??
      capture(source, /CLIENT_OWNED_VOICE_SHARED_ASSET = "([^"]+)"/u, "work shared"),
    overlayAsset: field("overlayAsset"),
    chatVersion: field("chatVersion") ?? workVersion,
    chatInitial: field("chatInitial") ?? workInitial,
    chatStart,
  };
}

export function readPins(files) {
  const work = files.clientOwned;
  const chat = files.nativeChat;
  const start = files.voiceStart ?? "";
  const owned = pinsFromOwnerObject(work) ?? pinsFromOwnerObject(chat);
  if (owned) return owned;
  const workVersion = capture(work, /CLIENT_OWNED_VOICE_VERSION = "([^"]+)"/u, "work version");
  const workInitial = capture(
    work,
    /CLIENT_OWNED_VOICE_INITIAL_ASSET = "([^"]+)"/u,
    "work initial",
  );
  return {
    workVersion,
    workInitial,
    workShared: capture(work, /CLIENT_OWNED_VOICE_SHARED_ASSET = "([^"]+)"/u, "work shared"),
    overlayAsset:
      optionalCapture(work, /CLIENT_OWNED_VOICE_OVERLAY_ASSET = "([^"]+)"/u) ??
      optionalCapture(start, /VOICE_START_OVERLAY_ASSET = "([^"]+)"/u),
    chatVersion: optionalCapture(chat, /NATIVE_CHAT_VOICE_VERSION = "([^"]+)"/u) ?? workVersion,
    chatInitial: optionalCapture(chat, /NATIVE_CHAT_INITIAL_ASSET = "([^"]+)"/u) ?? workInitial,
    chatStart: capture(chat, /START_ASSET = "([^"]+)"/u, "chat start"),
  };
}

export function parseAppcast(xml) {
  const item = xml.match(/<item>[\s\S]*?<\/item>/u)?.[0];
  if (!item) throw new Error("Appcast has no item");
  const version = item.match(
    /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/u,
  )?.[1];
  const build = item.match(/<sparkle:version>([^<]+)<\/sparkle:version>/u)?.[1];
  if (!version || !build) throw new Error("Appcast item missing version");
  const release = { version, build };
  for (const [key, tag] of [
    ["publishedAt", "pubDate"],
    ["minimumSystemVersion", "sparkle:minimumSystemVersion"],
    ["architecture", "sparkle:hardwareRequirements"],
    ["phasedRolloutInterval", "sparkle:phasedRolloutInterval"],
  ]) {
    const value = optionalCapture(item, new RegExp(`<${tag}>([^<]+)</${tag}>`, "u"));
    if (value) release[key] = value.trim();
  }
  return release;
}

function versionParts(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Invalid Desktop version: ${version}`);
  }
  return version.split(".").map((part) => BigInt(part));
}

function isNewer(latest, pin) {
  for (let index = 0; index < latest.length; index += 1) {
    if (latest[index] !== pin[index]) return latest[index] > pin[index];
  }
  return false;
}

/** Takes only qualification records already validated against the current source graph. */
export function monitoringBaselines(pins, qualification) {
  const baselines = {
    work: { version: pins.workVersion, source: "named-profile" },
    chat: { version: pins.chatVersion, source: "named-profile" },
  };
  const reviewed = qualification.reviewedEvidence.filter(
    (record) => record.platform === "darwin" && record.policy === "reviewed",
  );
  const candidates = reviewed.filter(
    (record) =>
      record.path === "chat" ||
      (record.path === "work-codex" &&
        reviewed.some(
          (other) =>
            other.path === "work-grok" &&
            other.desktopVersion === record.desktopVersion &&
            other.desktopBuild === record.desktopBuild,
        )),
  );
  for (const record of candidates) {
    const surface = record.path === "chat" ? "chat" : "work";
    const current = baselines[surface];
    const newer = isNewer(versionParts(record.desktopVersion), versionParts(current.version));
    const sameVersion = record.desktopVersion === current.version;
    const newerBuild =
      sameVersion &&
      /^\d+$/u.test(record.desktopBuild) &&
      (!current.build || BigInt(record.desktopBuild) > BigInt(current.build));
    if (!newer && !newerBuild) continue;
    baselines[surface] = {
      version: record.desktopVersion,
      build: record.desktopBuild,
      source: "reviewed-evidence",
      paths: surface === "chat" ? ["chat"] : ["work-codex", "work-grok"],
      implementationRevision: qualification.implementationRevision,
      evidence: "packages/renderer-extension/voice-reviewed-evidence.json",
    };
  }
  return baselines;
}

export function evaluate(
  pins,
  latest,
  baselines = monitoringBaselines(pins, { reviewedEvidence: [] }),
) {
  const latestParts = versionParts(latest.version);
  const findings = [];
  const scope = `The public macOS release feed advertises ${latest.version} build ${latest.build}. Desktop's per-installation updater may offer a different version. This check does not test native voice behavior or installation-specific update availability. Existing accepted voice activation is preserved; this alert does not revoke acceptance.`;
  for (const [key, label, namedVersion] of [
    ["work", "Work/Codex and Work/Grok", pins.workVersion],
    ["chat", "ChatGPT Chat", pins.chatVersion],
  ]) {
    const baseline = baselines[key];
    if (!isNewer(latestParts, versionParts(baseline.version))) continue;
    const origin =
      baseline.source === "reviewed-evidence"
        ? `reviewed accepted evidence (${baseline.paths.join(", ")}; implementation ${baseline.implementationRevision}; ${baseline.evidence})`
        : "the retained named profile";
    findings.push({
      surface: `${key}-voice`,
      title: `compat-daily/${key}-voice: pin ${baseline.version} behind desktop ${latest.version}`,
      detail: `${label} monitoring baseline is ${baseline.version}${baseline.build ? ` build ${baseline.build}` : ""}, from ${origin}. The retained named-profile version is ${namedVersion}; its asset mappings remain unchanged. ${scope} Voice on ${label} requires qualification for this public release.`,
    });
  }
  return {
    feed: { url: APPCAST_URL, installationAvailability: "not-checked" },
    latest,
    pins,
    baselines,
    findings,
  };
}

function trackerTitle(title) {
  return typeof title === "string"
    ? /^compat-daily\/(chat-voice|work-voice): pin (\d+\.\d+\.\d+) behind desktop (\d+\.\d+\.\d+)$/u.exec(
        title,
      )
    : undefined;
}

/** Refresh a changed baseline in place; supersede trackers when the feed advances. */
export function livePinIssue(finding, issues) {
  const target = trackerTitle(finding?.title);
  if (!target || target[1] !== finding.surface) return undefined;
  const matches = issues
    .filter((issue) => !issue.pull_request && trackerTitle(issue.title)?.[1] === finding.surface)
    .sort((left, right) => left.number - right.number);
  const live =
    matches.find((issue) => issue.title === finding.title) ??
    matches.find((issue) => trackerTitle(issue.title)[3] === target[3]);
  const previous = matches
    .filter((issue) => issue !== live)
    .map((issue) => ({ number: issue.number, title: issue.title }));
  if (live) {
    return {
      number: live.number,
      title: live.title,
      kind: live.title === finding.title ? "exact" : "refresh",
      previous,
    };
  }
  return previous.length > 0 ? { kind: "supersede", previous } : undefined;
}

/** Matching monitoring baselines clear version drift, independently of new live testing. */
export function recoveredPinIssues(report, issues) {
  return issues.flatMap((issue) => {
    const match = trackerTitle(issue.title);
    if (!match || issue.pull_request) return [];
    const surface = match[1];
    const key = surface === "chat-voice" ? "chat" : "work";
    const pin = report.baselines?.[key]?.version ?? report.pins[`${key}Version`];
    return pin === report.latest.version || pin === match[3]
      ? [{ number: issue.number, surface, version: pin }]
      : [];
  });
}

export async function loadMonitoringBaselines(root = ROOT, pins) {
  const namedPins = pins ?? (await loadPinsFromRepo(root));
  const { loadCurrentSourceVoiceIdentity } = await import(
    pathToFileURL(path.join(root, "scripts/release/voice-release-artifacts.mjs")).href
  );
  const { qualification } = await loadCurrentSourceVoiceIdentity(root);
  return monitoringBaselines(namedPins, qualification);
}

export async function loadPinsFromRepo(root = ROOT) {
  const profiles = await readFile(
    path.join(root, "packages/renderer-extension/src/renderer-voice-profiles.ts"),
    "utf8",
  );
  return readPins({ clientOwned: profiles, nativeChat: profiles });
}

export async function fetchAppcast(fetchImpl = fetch, url = APPCAST_URL) {
  const response = await fetchImpl(url, { headers: { accept: "application/xml,text/xml,*/*" } });
  if (!response.ok) throw new Error(`Appcast HTTP ${response.status}`);
  return parseAppcast(await response.text());
}

async function main() {
  const pins = await loadPinsFromRepo();
  const baselines = await loadMonitoringBaselines(ROOT, pins);
  const latest = await fetchAppcast();
  const report = evaluate(pins, latest, baselines);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.findings.length > 0) process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message, findings: [] }, null, 2)}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
