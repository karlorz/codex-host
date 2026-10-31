export const NPM_GITHUB_REPOSITORY = "karlorz/codex-host";
export const NPM_PACKAGE_NAME = "@karlorz/codexhost-cli";
export const NPM_PLATFORM_PACKAGE_NAMES = Object.freeze({
  "macos-arm64": "@karlorz/codexhost-cli-darwin-arm64",
  "macos-x64": "@karlorz/codexhost-cli-darwin-x64",
  "windows-x64": "@karlorz/codexhost-cli-win32-x64",
  "windows-arm64": "@karlorz/codexhost-cli-win32-arm64",
  "linux-x64": "@karlorz/codexhost-cli-linux-x64",
  "linux-arm64": "@karlorz/codexhost-cli-linux-arm64",
});

export function requireForkNpmIdentity(packageName) {
  if (!packageName.startsWith("@karlorz/")) {
    throw new Error(
      `refusing to publish ${packageName}; fork npm packages must use the @karlorz scope`,
    );
  }
}

requireForkNpmIdentity(NPM_PACKAGE_NAME);
for (const packageName of Object.values(NPM_PLATFORM_PACKAGE_NAMES)) {
  requireForkNpmIdentity(packageName);
}

export function npmPackageRepositoryFields() {
  return {
    repository: {
      type: "git",
      url: `git+https://github.com/${NPM_GITHUB_REPOSITORY}.git`,
    },
    bugs: { url: `https://github.com/${NPM_GITHUB_REPOSITORY}/issues` },
    homepage: `https://github.com/${NPM_GITHUB_REPOSITORY}#readme`,
  };
}
export const NPM_RUNTIME_PLATFORM_PACKAGES = Object.freeze({
  "darwin-arm64": NPM_PLATFORM_PACKAGE_NAMES["macos-arm64"],
  "darwin-x64": NPM_PLATFORM_PACKAGE_NAMES["macos-x64"],
  "win32-x64": NPM_PLATFORM_PACKAGE_NAMES["windows-x64"],
  "win32-arm64": NPM_PLATFORM_PACKAGE_NAMES["windows-arm64"],
  "linux-x64": NPM_PLATFORM_PACKAGE_NAMES["linux-x64"],
  "linux-arm64": NPM_PLATFORM_PACKAGE_NAMES["linux-arm64"],
});
export const NPM_PACKAGE_DESCRIPTION =
  "Run Pi and Claude Code as first-class external harnesses inside Codex Desktop.";

export function npmPlatformPackageName(target) {
  const packageName = NPM_PLATFORM_PACKAGE_NAMES[target.id];
  if (!packageName) throw new Error(`unsupported npm package target: ${target.id}`);
  return packageName;
}

export function npmTarballFileName({ version, target }) {
  return `codexhost-cli-${version}-${target.id}.tgz`;
}

export function npmMetaTarballFileName(version) {
  return `codexhost-cli-${version}.tgz`;
}
