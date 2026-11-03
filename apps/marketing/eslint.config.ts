import { defineConfig } from "eslint/config";

import { baseConfig } from "@expendi-business/eslint-config/base";
import { nextjsConfig } from "@expendi-business/eslint-config/nextjs";
import { reactConfig } from "@expendi-business/eslint-config/react";

export default defineConfig(
  { ignores: [".next/**", "next-env.d.ts", "public/**"] },
  baseConfig,
  reactConfig,
  nextjsConfig,
);
