import { defineConfig } from "vitest/config";

import {
  TEST_DATABASE_URL,
  TEST_DATABASE_URL_MIGRATE,
} from "./src/__tests__/setup/test-database.js";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    globalSetup: ["src/__tests__/setup/global-setup.ts"],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_URL_MIGRATE: TEST_DATABASE_URL_MIGRATE,
    },
    testTimeout: 10_000,
  },
});
