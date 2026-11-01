import { defineConfig } from "eslint/config";

import { baseConfig } from "@expendi-business/eslint-config/base";

export default defineConfig({ ignores: ["dist/**"] }, baseConfig);
