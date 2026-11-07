/** `/recurring` → the Bills sheet's list; `/recurring?itemId=x` → that payment. */
export function recurringRedirect(
  itemId: string | string[] | undefined,
): string {
  const target = typeof itemId === "string" && itemId !== "" ? itemId : "all";
  return `/bills?recurring=${encodeURIComponent(target)}`;
}
