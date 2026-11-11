import type { SortingState } from "@tanstack/react-table";

export type SortDirection = "asc" | "desc";

/** The column and direction a page's list is sorted by. */
export interface SortState<K extends string> {
  readonly key: K;
  readonly dir: SortDirection;
}

/**
 * The sort after a header is pressed: the same column flips; another
 * column starts in its own natural direction (e.g. amounts high to low).
 */
export function nextSort<K extends string>(
  current: SortState<K>,
  key: K,
  firstDir: SortDirection,
): SortState<K> {
  if (current.key !== key) return { key, dir: firstDir };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** The table's sorting state for a page that keeps one `SortState`. */
export function toSorting<K extends string>(sort: SortState<K>): SortingState {
  return [{ id: sort.key, desc: sort.dir === "desc" }];
}

/**
 * The column a header press asked for. The page decides the direction
 * (`nextSort`), so only the column matters; a press that clears the sort
 * means the sorted column again.
 */
export function pressedKey<K extends string>(
  next: SortingState,
  current: SortState<K>,
  keys: readonly K[],
): K {
  const id = next[0]?.id ?? current.key;
  return keys.find((key) => key === id) ?? current.key;
}

/**
 * The page's sort after the table changed its sorting: TanStack's column
 * and direction for a known key; the current column flipped when the sort
 * was cleared or names an unknown key.
 */
export function sortFromTable<K extends string>(
  next: SortingState,
  current: SortState<K>,
  keys: readonly K[],
): SortState<K> {
  const [first] = next;
  const key = keys.find((candidate) => candidate === first?.id);
  if (first && key) return { key, dir: first.desc ? "desc" : "asc" };
  return { key: current.key, dir: current.dir === "asc" ? "desc" : "asc" };
}
