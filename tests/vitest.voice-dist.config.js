import { defineConfig } from "vitest/config";

import baseConfig, { VOICE_DIST_ARTIFACT_TEST_GLOB } from "./vitest.config.js";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [VOICE_DIST_ARTIFACT_TEST_GLOB],
    exclude: (baseConfig.test.exclude ?? []).filter(
      (entry) => entry !== VOICE_DIST_ARTIFACT_TEST_GLOB,
    ),
  },
});
