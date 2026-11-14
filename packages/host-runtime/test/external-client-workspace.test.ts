import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalizeWorkspace,
  workspaceAllowed,
  workspaceContains,
} from "../src/external-client-workspace.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("external client workspace policy", () => {
  it("resolves symlinks and contains paths inside the real root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ext-ws-"));
    cleanup.push(root);
    const real = path.join(root, "project");
    const link = path.join(root, "alias");
    await writeFile(path.join(root, "keep"), "x");
    await mkdir(real);
    await writeFile(path.join(real, "file.txt"), "ok");
    await symlink(real, link);
    const canonical = await canonicalizeWorkspace(link);
    expect(canonical).toBe(await canonicalizeWorkspace(real));
    expect(workspaceContains(canonical, path.join(canonical, "file.txt"))).toBe(true);
    expect(workspaceAllowed([canonical], path.join(canonical, "nested", "a"))).toBe(true);
    expect(workspaceContains(canonical, root)).toBe(false);
  });

  it("denies unresolved workspace paths", async () => {
    await expect(
      canonicalizeWorkspace(path.join(os.tmpdir(), "missing-ext-ws-root")),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED_TARGET",
    });
  });

  it("does not treat a sibling worktree as inside the selected root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ext-ws-root-"));
    cleanup.push(root);
    const worktree = await mkdtemp(path.join(os.tmpdir(), "ext-ws-worktree-"));
    cleanup.push(worktree);
    const canonicalRoot = await canonicalizeWorkspace(root);
    const canonicalWorktree = await canonicalizeWorkspace(worktree);
    expect(workspaceAllowed([canonicalRoot], canonicalWorktree)).toBe(false);
    expect(workspaceAllowed([canonicalRoot], path.join(canonicalRoot, "src"))).toBe(true);
  });
});
