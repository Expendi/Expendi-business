import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/api/src`. */
export const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Relative value imports and re-exports: `import type` and `export type`
 * are erased at build time, so they can't run anything.
 */
const LOCAL_SPECIFIER =
  /(?:^|\n)\s*(?:import(?!\s+type\b)[^'"]*?from\s*|import\s*|export(?!\s+type\b)[^'"]*?from\s*)["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

function resolveModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Every source file `entry` can run, following relative imports. Paths are
 * relative to `src/`, e.g. `services/payout/sync.ts`.
 */
export function reachableModules(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const pending = [path.join(SRC_DIR, entry)];
  for (let file = pending.pop(); file; file = pending.pop()) {
    const relative = path.relative(SRC_DIR, file);
    if (seen.has(relative)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(relative, source);
    for (const match of source.matchAll(LOCAL_SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      const resolved = specifier ? resolveModule(file, specifier) : null;
      if (resolved) pending.push(resolved);
    }
  }
  return seen;
}
