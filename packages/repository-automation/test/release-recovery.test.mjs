import { describe, expect, it } from "vitest";
import { validateRecoveryRun, verifyRecoveryEvidence } from "../src/release-recovery.mjs";

const targets = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "windows-arm64",
  "linux-x64",
  "linux-arm64",
];
const release = {
  tag: "v0.16.1-0",
  version: "0.16.1-0",
  sha: "a".repeat(40),
  tagObjectSha: "b".repeat(40),
  ciRunId: 42,
  ciRunAttempt: 1,
  npmTag: "latest",
  prerelease: false,
  notes: "Approved notes\n",
};

function fixture() {
  const run = {
    path: ".github/workflows/release-packages.yml",
    event: "push",
    head_sha: release.sha,
    head_branch: release.tag,
    status: "completed",
  };
  const jobs = {
    jobs: targets.map((target) => ({
      name: `Build ${target}`,
      status: "completed",
      conclusion: "success",
    })),
    total_count: 8,
  };
  const artifacts = {
    artifacts: [...targets.map((target) => `codexhost-${target}`), "release-notes"].map((name) => ({
      name,
      expired: false,
      size_in_bytes: 100,
    })),
    total_count: 7,
  };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: run }),
        listJobsForWorkflowRun: async () => ({ data: jobs }),
        listWorkflowRunArtifacts: async () => ({ data: artifacts }),
      },
    },
  };
  return {
    run,
    jobs,
    artifacts,
    options: { github, repo: { owner: "karlorz", repo: "codex-host" }, runId: "123", release },
  };
}

describe("original release artifact recovery", () => {
  it("accepts only an original completed tag run with six successful builds and retained artifacts", async () => {
    expect(await validateRecoveryRun(fixture().options)).toBe("123");
  });
  it.each([
    ["path", ".github/workflows/ci.yml"],
    ["event", "pull_request"],
    ["head_sha", "c".repeat(40)],
    ["head_branch", "main"],
    ["status", "in_progress"],
  ])("rejects an unrelated run: %s", async (key, value) => {
    const f = fixture();
    f.run[key] = value;
    await expect(validateRecoveryRun(f.options)).rejects.toThrow("original tag-push release run");
  });
  it("rejects failed builds, expired artifacts, and invalid run IDs", async () => {
    const f = fixture();
    f.jobs.jobs[0].conclusion = "failure";
    await expect(validateRecoveryRun(f.options)).rejects.toThrow("successful Build macos-arm64");
    f.jobs.jobs[0].conclusion = "success";
    f.artifacts.artifacts[0].expired = true;
    await expect(validateRecoveryRun(f.options)).rejects.toThrow("expired recovery artifact");
    await expect(validateRecoveryRun({ ...f.options, runId: "-1" })).rejects.toThrow(
      "positive integer",
    );
  });
  it("binds original artifacts to the same annotated tag, notes and exact CI evidence", () => {
    expect(() =>
      verifyRecoveryEvidence(
        { ...release, automationSha: "old" },
        { ...release, automationSha: "new" },
        release.notes,
      ),
    ).not.toThrow();
    for (const key of [
      "tag",
      "version",
      "sha",
      "tagObjectSha",
      "ciRunId",
      "ciRunAttempt",
      "npmTag",
      "prerelease",
    ]) {
      expect(() =>
        verifyRecoveryEvidence({ ...release, [key]: "changed" }, release, release.notes),
      ).toThrow(`differs: ${key}`);
    }
    expect(() => verifyRecoveryEvidence(release, release, "changed notes")).toThrow("notes differ");
  });
});
