import * as SecureStore from "expo-secure-store";

/** Keys allow only letters, digits, ".", "-" and "_", so the user is our UUID, not a Privy DID. */
function storageKey(userId: string): string {
  return `selected-company-${userId}`;
}

export function readSelectedCompanyId(userId: string): Promise<string | null> {
  return SecureStore.getItemAsync(storageKey(userId));
}

export function saveSelectedCompanyId(
  userId: string,
  organizationId: string,
): Promise<void> {
  return SecureStore.setItemAsync(storageKey(userId), organizationId);
}
