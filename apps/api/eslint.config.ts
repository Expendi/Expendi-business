import { defineConfig } from "eslint/config";

import { baseConfig } from "@expendi-business/eslint-config/base";
import { restrictEnvAccess } from "@expendi-business/eslint-config/node";

export default defineConfig(
  { ignores: ["dist/**", "drizzle/**"] },
  baseConfig,
  restrictEnvAccess,
);
