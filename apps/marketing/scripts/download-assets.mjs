#!/usr/bin/env node
/**
 * Mirrors every third-party asset the qonto.com/en reference page uses into
 * `public/`. The URL → local path map lives in `asset-manifest.json`, generated
 * during reconnaissance from the rendered DOM and network log at 1440/768/390.
 *
 * Usage: node scripts/download-assets.mjs [--force]
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(scriptDir, "../public");
const force = process.argv.includes("--force");

/** @type {Record<string, string>} */
const manifest = JSON.parse(
  await readFile(path.join(scriptDir, "asset-manifest.json"), "utf8"),
);

/** @param {string} file */
async function exists(file) {
  try {
    const info = await stat(file);
    return info.size > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * @param {string} url
 * @param {string} localPath
 * @returns {Promise<"downloaded" | "skipped">}
 */
async function download(url, localPath) {
  const target = path.join(publicDir, localPath);
  if (!force && (await exists(target))) return "skipped";

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Referer: "https://qonto.com/en" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
      return "downloaded";
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(
    `${url} → ${localPath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

const queue = Object.entries(manifest);
const results = {
  downloaded: 0,
  skipped: 0,
  failed: /** @type {string[]} */ ([]),
};

async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [url, localPath] = next;
    try {
      const outcome = await download(url, localPath);
      results[outcome]++;
      console.log(`${outcome.padEnd(10)} ${localPath}`);
    } catch (error) {
      results.failed.push(
        error instanceof Error ? error.message : String(error),
      );
      console.error(`failed     ${localPath}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

console.log(
  `\n${results.downloaded} downloaded, ${results.skipped} skipped, ${results.failed.length} failed`,
);
if (results.failed.length > 0) {
  console.error(results.failed.join("\n"));
  process.exitCode = 1;
}
