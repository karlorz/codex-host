import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath, rm, mkdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installedApp = "/Applications/codexhost.app";
const slotPattern = /^local-app-build-(\d{8}T\d{6}Z)$/;

async function directories(root) {
  try {
    if (!(await lstat(root)).isDirectory()) return [];
    return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function defaultRoots(home = homedir()) {
  const downloads = path.join(home, "Downloads");
  return [
    path.join(home, "Library/Application Support/codexhost/app-backups"),
    ...(await directories(downloads))
      .filter((entry) => entry.name.startsWith("codexhost-"))
      .map((entry) => path.join(downloads, entry.name)),
  ];
}

async function inspect(slot) {
  const receiptPath = path.join(slot, "install-receipt.json");
  const bundle = path.join(slot, "codexhost.app");
  try {
    const metadata = await lstat(receiptPath);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return null;
    const bytes = await readFile(receiptPath, "utf8");
    const receipt = JSON.parse(bytes);
    if (
      receipt.full_local_build !== true ||
      receipt.app !== installedApp ||
      receipt.backup !== bundle ||
      !(await lstat(bundle)).isDirectory() ||
      (await realpath(bundle)) !== bundle
    ) {
      return null;
    }
    return { bundle, bytes };
  } catch (error) {
    if (error instanceof SyntaxError || error.code === "ENOENT") return null;
    throw error;
  }
}

// Only completed local-build receipts admit a bundle into count-based retention.
export async function collectBackups(roots, { apply = false } = {}) {
  const candidates = [];
  const seen = new Set();
  for (const root of roots) {
    let resolvedRoot;
    for (const entry of await directories(root)) {
      const match = slotPattern.exec(entry.name);
      if (!match) continue;
      resolvedRoot ??= await realpath(root);
      const slot = path.join(resolvedRoot, entry.name);
      const backup = await inspect(slot);
      if (!backup || seen.has(backup.bundle)) continue;
      seen.add(backup.bundle);
      candidates.push({ ...backup, timestamp: match[1] });
    }
  }
  candidates.sort(
    (a, b) => b.timestamp.localeCompare(a.timestamp) || a.bundle.localeCompare(b.bundle),
  );
  const keep = candidates.slice(0, 2).map((entry) => entry.bundle);
  const prune = candidates.slice(2);
  if (apply) {
    for (const entry of prune) {
      const current = await inspect(path.dirname(entry.bundle));
      if (!current || current.bytes !== entry.bytes) {
        throw new Error(`Backup changed during GC: ${entry.bundle}`);
      }
      await rm(entry.bundle, { recursive: true });
    }
  }
  return {
    apply,
    retention: 2,
    keep,
    [apply ? "removed" : "would_remove"]: prune.map((x) => x.bundle),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply"))
    throw new Error("Usage: npm run backups:gc -- [--apply]");
  const apply = args.includes("--apply");
  const root = path.join(homedir(), "Library/Application Support/codexhost/app-backups");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".gc-lock");
  await mkdir(lock);
  try {
    if (apply) {
      if (process.platform !== "darwin") throw new Error("App backup GC requires macOS");
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installedApp], {
        stdio: "pipe",
      });
    }
    console.log(JSON.stringify(await collectBackups(await defaultRoots(), { apply }), null, 2));
  } finally {
    await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
