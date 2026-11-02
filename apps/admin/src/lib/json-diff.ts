export type DiffKind = "added" | "removed" | "changed" | "unchanged";

export interface DiffRow {
  path: string;
  before: string | undefined;
  after: string | undefined;
  kind: DiffKind;
}

const ROOT = "(value)";

function childPath(parent: string, key: string, inArray: boolean): string {
  if (inArray) return `${parent === ROOT ? "" : parent}[${key}]`;
  return parent === ROOT ? key : `${parent}.${key}`;
}

/** Every leaf of a JSON value, keyed by its path, e.g. `after.amounts[0]`. */
function leaves(value: unknown, path = ROOT, out = new Map<string, string>()) {
  if (value !== null && typeof value === "object") {
    const inArray = Array.isArray(value);
    const entries: [string, unknown][] = inArray
      ? value.map((inner: unknown, index) => [String(index), inner])
      : Object.entries(value);
    if (entries.length === 0) {
      out.set(path, inArray ? "[]" : "{}");
      return out;
    }
    for (const [key, inner] of entries) {
      leaves(inner, childPath(path, key, inArray), out);
    }
    return out;
  }
  out.set(path, JSON.stringify(value));
  return out;
}

/**
 * A field-by-field comparison of an audit entry's `before` and `after`. A
 * missing side (null) has no fields, so everything on the other side is
 * added or removed.
 */
export function diffJson(before: unknown, after: unknown): DiffRow[] {
  const from = before === null ? new Map<string, string>() : leaves(before);
  const to = after === null ? new Map<string, string>() : leaves(after);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  return paths.map((path) => {
    const left = from.get(path);
    const right = to.get(path);
    const kind: DiffKind =
      left === undefined
        ? "added"
        : right === undefined
          ? "removed"
          : left === right
            ? "unchanged"
            : "changed";
    return { path, before: left, after: right, kind };
  });
}
