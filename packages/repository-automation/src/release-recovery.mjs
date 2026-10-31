const targets = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "windows-arm64",
  "linux-x64",
  "linux-arm64",
];

/** Recovery reuses completed, tag-bound builds rather than rebuilding accepted npm versions. */
export async function validateRecoveryRun({ github, repo, runId, release }) {
  if (!/^[1-9]\d*$/u.test(String(runId)))
    throw new Error("recovery run ID must be a positive integer");
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId });
  if (
    run.path !== ".github/workflows/release-packages.yml" ||
    run.event !== "push" ||
    run.head_sha !== release.sha ||
    run.head_branch !== release.tag ||
    run.status !== "completed"
  ) {
    throw new Error(
      "recovery requires a completed original tag-push release run at the exact release SHA",
    );
  }
  const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
    ...repo,
    run_id: runId,
    per_page: 100,
  });
  const { data: artifacts } = await github.rest.actions.listWorkflowRunArtifacts({
    ...repo,
    run_id: runId,
    per_page: 100,
  });
  if (jobs.total_count > 100 || artifacts.total_count > 100)
    throw new Error("unexpected recovery run inventory");
  for (const target of targets) {
    const matches = jobs.jobs.filter((job) => job.name === `Build ${target}`);
    if (
      matches.length !== 1 ||
      matches[0].conclusion !== "success" ||
      matches[0].status !== "completed"
    ) {
      throw new Error(`recovery requires a successful Build ${target}`);
    }
  }
  for (const name of [...targets.map((target) => `codexhost-${target}`), "release-notes"]) {
    const matches = artifacts.artifacts.filter((artifact) => artifact.name === name);
    if (matches.length !== 1 || matches[0].expired || matches[0].size_in_bytes <= 0) {
      throw new Error(`missing or expired recovery artifact: ${name}`);
    }
  }
  return String(runId);
}

export function verifyRecoveryEvidence(original, current, originalNotes) {
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
    if (original[key] !== current[key]) throw new Error(`recovery evidence differs: ${key}`);
  }
  if (originalNotes !== current.notes)
    throw new Error("recovery release notes differ from annotated tag");
}
