import { defineConfig } from "eslint/config";

/**
 * Configuration flows through Effect `Config` (and the secrets bootstrap that
 * fills `process.env` from Doppler before it is read), so ad-hoc
 * `process.env` reads would bypass validation and redaction.
 */
export const restrictEnvAccess = defineConfig({
  files: ["**/*.ts"],
  ignores: ["**/secrets/**", "**/__tests__/**"],
  rules: {
    "no-restricted-properties": [
      "error",
      {
        object: "process",
        property: "env",
        message: "Read configuration through Effect Config (src/config.ts).",
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        name: "process",
        importNames: ["env"],
        message: "Read configuration through Effect Config (src/config.ts).",
      },
    ],
  },
});
