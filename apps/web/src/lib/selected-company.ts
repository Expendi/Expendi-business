/** Keyed by our user ID, so two people sharing a browser keep their own choice. */
function storageKey(userId: string): string {
  return `expendi-business:selected-company:${userId}`;
}

/**
 * Storage can be unavailable (private windows, blocked site data). The
 * choice is a convenience: without it the picker simply asks again.
 */
export function readSelectedCompanyId(userId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(userId));
  } catch (error) {
    console.warn("[company] couldn't read the remembered company", error);
    return null;
  }
}

export function saveSelectedCompanyId(
  userId: string,
  organizationId: string,
): void {
  try {
    window.localStorage.setItem(storageKey(userId), organizationId);
  } catch (error) {
    console.warn("[company] couldn't remember the company", error);
  }
}
