import { globSync } from "node:fs";
import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

import { isPlatformTest } from "./platform-tests.mjs";

const root = path.resolve(import.meta.dirname, "..");

const include = [
  "packages/**/test/**/*.test.ts",
  "tests/integration/**/*.test.ts",
  "apps/web-ui/packages/client/hmr/tests/*.spec.ts",
  "packages/repository-automation/test/**/*.test.mjs",
  "tests/release/**/*.test.mjs",
  "tools/**/*.test.mjs",
];

// Built Renderer identity. Kept out of `test:typescript` so a frozen local
// dist cannot fail the suite. Linux CI builds the Renderer once, then runs
// this glob through tests/vitest.voice-dist.config.js. Passing the file on
// the shared-config CLI still honors this exclude (No test files found).
export const VOICE_DIST_ARTIFACT_TEST_GLOB = "tests/release/**/*.dist.test.mjs";

// A test file touches OS behavior when it uses the filesystem, processes,
// paths, the environment, or branches on the platform.
const platformSensitive =
  /node:(fs|child_process|os|path|net|worker_threads|url)|process\.(platform|env|execPath|kill|pid)|win32|tmpdir|spawn|execFile|MappingStore|mkdtemp|\.exe\b|USERPROFILE|APPDATA|\\\\/;

// CODEXHOST_TEST_SCOPE=platform runs only platform-sensitive files. Secondary
// OS lanes (macOS and Windows) use it; Linux x64 covers pure-logic files.
// Linux ARM64 CI runs native checks and package smoke instead of TS tests.
function platformIndependentFiles() {
  return globSync(include, { cwd: root, exclude: (name) => name === "node_modules" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !isPlatformTest(path.join(root, file)));
}

const platformOnly = process.env.CODEXHOST_TEST_SCOPE === "platform";

export default defineConfig({
  root,
  test: {
    environment: "node",
    include,
    // Imported DSH packages expose their TypeScript sources; Vite must transform
    // them instead of handing them to Node's native loader.
    server: { deps: { inline: [/@deepseek-ai\//] } },
    // The Web Host owns Node test-runner suites, invoked by npm run test:web.
    exclude: [
      ...configDefaults.exclude,
      "tools/compat-daily/**",
      // Node's runner via `npm run voice:discovery:test`; Linux CI runs that
      // after the Renderer build. Vitest has no suite here.
      "tools/voice-discovery/**",
      "packages/web-server/test/**",
      // Native service tests use Node's runner after building the Rust Launcher.
      "packages/host-runtime/test/native/**",
      VOICE_DIST_ARTIFACT_TEST_GLOB,
      ...(platformOnly ? platformIndependentFiles() : []),
    ],
    maxWorkers: 4,
    passWithNoTests: false,
    // Hosted Windows runners have highly variable disk latency (fsync + rename
    // under real-time scanning): the same Mapping Store suite ranges from
    // ~0.4s to ~10s between runs. Hosted Intel macOS runners are slower than
    // ARM images for plugin-load and stdio-bridge tests. Keep the default
    // elsewhere so real hangs still fail fast.
    ...(process.platform === "win32" || (process.platform === "darwin" && process.arch === "x64")
      ? { testTimeout: 20_000, hookTimeout: 30_000 }
      : {}),
  },
});
