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
};

export default config;
