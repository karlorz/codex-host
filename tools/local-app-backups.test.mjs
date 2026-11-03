import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { collectBackups, defaultRoots } from "./local-app-backups.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-backups-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function backup(root, day, fields = {}) {
  const slot = path.join(root, `local-app-build-202611${String(day).padStart(2, "0")}T000000Z`);
  const bundle = path.join(slot, "codexhost.app");
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "rollback-marker"), "keep until rotated");
  await writeFile(
    path.join(slot, "install-receipt.json"),
    JSON.stringify({
      app: "/Applications/codexhost.app",
      backup: bundle,
      full_local_build: true,
      ...fields,
    }),
  );
  return bundle;
}

test("preview preserves everything; apply keeps newest two across roots and preserves receipts", async (t) => {
  const root = await fixture(t);
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const old = await backup(first, 1);
  const middle = await backup(second, 2);
  const newest = await backup(first, 3);
  const preview = await collectBackups([first, second, first]);
  assert.deepEqual(preview.keep, [newest, middle]);
  assert.deepEqual(preview.would_remove, [old]);
  await access(old);
  const applied = await collectBackups([first, second], { apply: true });
  assert.deepEqual(applied.removed, [old]);
  await assert.rejects(access(old), { code: "ENOENT" });
  await access(path.join(path.dirname(old), "install-receipt.json"));
  await access(newest);
  await access(middle);
  assert.deepEqual((await collectBackups([first, second], { apply: true })).removed, []);
});

test("incomplete, malformed, mismatched and unrecognized receipts never admit backups to GC", async (t) => {
  const root = await fixture(t);
  const incomplete = await backup(root, 1, { full_local_build: false });
  const wrongTarget = await backup(root, 2, { app: "/Applications/Other.app" });
  const wrongBackup = await backup(root, 3, { backup: "/Applications/codexhost.app" });
  const malformed = await backup(root, 4);
  await writeFile(path.join(path.dirname(malformed), "install-receipt.json"), "{broken");
  const unrelated = path.join(root, "candidate.app");
  await mkdir(unrelated);
  await backup(root, 5);
  await backup(root, 6);
  assert.deepEqual((await collectBackups([root], { apply: true })).removed, []);
  for (const item of [incomplete, wrongTarget, wrongBackup, malformed, unrelated])
    await access(item);
});

test("symlinked bundles, receipts, slots and roots are excluded, without touching destinations", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside");
  const managed = path.join(root, "managed");
  const destination = await backup(outside, 1);
  const linkedBundle = await backup(managed, 1);
  await rm(linkedBundle, { recursive: true });
  await symlink(destination, linkedBundle);
  const linkedReceipt = await backup(managed, 2);
  const receipt = path.join(path.dirname(linkedReceipt), "install-receipt.json");
  const saved = path.join(root, "saved-receipt.json");
  await writeFile(saved, await readFile(receipt));
  await rm(receipt);
  await symlink(saved, receipt);
  await symlink(path.dirname(destination), path.join(managed, "local-app-build-20261103T000000Z"));
  const linkedRoot = path.join(root, "linked-root");
  await symlink(outside, linkedRoot);
  await backup(managed, 5);
  await backup(managed, 6);
  const result = await collectBackups([managed, linkedRoot], { apply: true });
  assert.deepEqual(result.removed, []);
  assert.equal(result.keep.length, 2);
  await access(path.join(destination, "rollback-marker"));
});

test("default discovery stays within the managed root and direct codexhost Downloads roots", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "Downloads/codexhost-old"), { recursive: true });
  await mkdir(path.join(root, "Downloads/unrelated"));
  const roots = await defaultRoots(root);
  assert.deepEqual(roots, [
    path.join(root, "Library/Application Support/codexhost/app-backups"),
    path.join(root, "Downloads/codexhost-old"),
  ]);
});
