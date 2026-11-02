import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** @type {import("next").NextConfig} */
const config = {
  /** Pin the workspace root so module resolution ignores stray parent lockfiles */
  turbopack: { root: workspaceRoot },

  /** Typechecking and linting run as their own turbo tasks */
  typescript: { ignoreBuildErrors: true },

  /**
   * The passkey association files in `public/.well-known/` (spec §6.14).
   * Apple and Google read them only as JSON, and the Apple file has no
   * extension to infer that from.
   */
  async headers() {
    return [
      {
        source:
          "/.well-known/:file(apple-app-site-association|assetlinks\\.json)",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
    ];
  },
};

export default config;
