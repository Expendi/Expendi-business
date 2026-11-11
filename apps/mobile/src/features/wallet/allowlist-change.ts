import type { AllowlistChange, PayeeChain } from "@expendi-business/shared";
import { allowlistChangeSchema } from "@expendi-business/shared";

export interface AllowlistFieldErrors {
  readonly address?: string;
  readonly label?: string;
}

export type AddressToAdd =
  | { readonly ok: true; readonly change: AllowlistChange }
  | { readonly ok: false; readonly errors: AllowlistFieldErrors };

/**
 * The change that adds an address on `chain`, checked with the API's own
 * schema so the address must be one that chain can pay.
 */
export function addressToAdd(
  chain: PayeeChain,
  label: string,
  address: string,
): AddressToAdd {
  const parsed = allowlistChangeSchema.safeParse({
    action: "add",
    chain,
    label,
    address,
  });
  if (parsed.success) return { ok: true, change: parsed.data };
  const errors: { address?: string; label?: string } = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "address" || field === "label") {
      errors[field] ??= issue.message;
    }
  }
  return { ok: false, errors };
}
