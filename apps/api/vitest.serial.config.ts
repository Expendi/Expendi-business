import { defineConfig } from "vitest/config";

import base from "./vitest.config.js";

/**
 * Tests that change platform-wide state, run on their own after the main
 * suite (`pnpm test` runs both): one file at a time, against a freshly
 * rebuilt test database. Replaces include/exclude rather than merging,
 * since mergeConfig would concatenate them.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/__tests__/**/*.serial.test.ts"],
    exclude: [],
    fileParallelism: false,
  },
});
