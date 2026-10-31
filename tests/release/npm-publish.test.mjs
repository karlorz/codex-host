import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createNpmPublishPlan,
  createNpmResumePlan,
  parseNpmPublishArguments,
} from "../../scripts/release/publish-npm.mjs";

describe("npm registry publishing", () => {
  it("loads the publisher without dependencies or workspace builds", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "codexhost-source-publisher-")),
    );
    try {
      for (const name of ["publish-npm.mjs", "npm-package-identity.mjs", "targets.mjs"]) {
        await copyFile(
          path.resolve(import.meta.dirname, "../../scripts/release", name),
          path.join(root, name),
        );
      }
      const result = spawnSync(process.execPath, [path.join(root, "publish-npm.mjs"), "--help"], {
        encoding: "utf8",
        cwd: root,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--resume");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("parses an explicit safe publishing request", () => {
    expect(
      parseNpmPublishArguments([
        "--artifacts",
        "/artifacts",
        "--version",
        "0.1.0-test.1",
        "--tag",
        "test",
        "--dry-run",
        "--provenance",
      ]),
    ).toEqual({
      artifactsRoot: "/artifacts",
      dryRun: true,
      provenance: true,
      registry: undefined,
      tag: "test",
      version: "0.1.0-test.1",
      resume: false,
    });
  });

  it("requires an explicit resume flag", () => {
    expect(
      parseNpmPublishArguments(["--artifacts", "/artifacts", "--version", "0.16.1-0", "--resume"])
        .resume,
    ).toBe(true);
  });

  it("skips only identical published artifacts and preserves missing-package order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-resume-"));
    try {
      const tarball = path.join(root, "test.tgz");
      await writeFile(tarball, "original artifact");
      const plan = ["darwin-arm64", "linux-x64", "linux-arm64"].map((platform) => ({
        packageName: `@karlorz/codexhost-cli-${platform}`,
        version: "0.16.1-0",
        tarball,
      }));
      const fetchRegistry = async (url) => {
        const name = decodeURIComponent(url.pathname.slice(1));
        return new Response(
          JSON.stringify({
            name,
            versions: name.endsWith("darwin-arm64")
              ? {
                  "0.16.1-0": {
                    name,
                    version: "0.16.1-0",
                    dist: {
                      integrity: `sha512-${createHash("sha512").update("original artifact").digest("base64")}`,
                    },
                  },
                }
              : {},
            "dist-tags": { latest: "0.16.1-0" },
          }),
        );
      };
      expect(await createNpmResumePlan(plan, { tag: "latest" }, fetchRegistry)).toEqual(
        plan.slice(1),
      );
      expect(
        await createNpmResumePlan(
          plan,
          { tag: "latest" },
          async () => new Response("", { status: 404 }),
        ),
      ).toEqual(plan);
      await expect(
        createNpmResumePlan(plan, { tag: "latest" }, async () => new Response("", { status: 503 })),
      ).rejects.toThrow("registry lookup failed");
      await expect(
        createNpmResumePlan(plan, { tag: "latest" }, async () => new Response("{}")),
      ).rejects.toThrow("invalid registry metadata");
      await expect(createNpmResumePlan(plan, { tag: "next" }, fetchRegistry)).rejects.toThrow(
        "unexpected next tag",
      );
      await writeFile(tarball, "changed artifact");
      await expect(createNpmResumePlan(plan, { tag: "latest" }, fetchRegistry)).rejects.toThrow(
        "differs from release artifact",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes all platform packages before the meta package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-publish-"));
    const version = "0.1.0-test.1";
    const names = [
      `codexhost-cli-${version}-macos-arm64.tgz`,
      `codexhost-cli-${version}-macos-x64.tgz`,
      `codexhost-cli-${version}-windows-x64.tgz`,
      `codexhost-cli-${version}-windows-arm64.tgz`,
      `codexhost-cli-${version}-linux-x64.tgz`,
      `codexhost-cli-${version}-linux-arm64.tgz`,
      `codexhost-cli-${version}.tgz`,
    ];
    try {
      await mkdir(path.join(root, "nested"));
      for (const name of names) await writeFile(path.join(root, "nested", name), name);
      const plan = await createNpmPublishPlan({ artifactsRoot: root, version });
      expect(plan.map((entry) => entry.packageName)).toEqual([
        "@karlorz/codexhost-cli-darwin-arm64",
        "@karlorz/codexhost-cli-darwin-x64",
        "@karlorz/codexhost-cli-win32-x64",
        "@karlorz/codexhost-cli-win32-arm64",
        "@karlorz/codexhost-cli-linux-x64",
        "@karlorz/codexhost-cli-linux-arm64",
        "@karlorz/codexhost-cli",
      ]);
      expect(plan.at(-1).kind).toBe("meta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete release artifacts before publishing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-publish-"));
    try {
      await expect(createNpmPublishPlan({ artifactsRoot: root, version: "0.1.0" })).rejects.toThrow(
        "missing npm release tarball",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
