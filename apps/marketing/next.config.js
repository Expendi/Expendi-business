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

  /** Every asset is a local file in `public/`; the AVIF sources are already optimised */
  images: { unoptimized: true },
};

export default config;
