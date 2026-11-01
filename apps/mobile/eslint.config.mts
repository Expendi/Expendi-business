import { defineConfig } from "eslint/config";

import { baseConfig } from "@expendi-business/eslint-config/base";
import { reactConfig } from "@expendi-business/eslint-config/react";

export default defineConfig(
  { ignores: [".expo/**", "android/**", "ios/**", "entrypoint.js"] },
  baseConfig,
  reactConfig,
);
