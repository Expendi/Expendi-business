import type { Customer, CustomerInput } from "@expendi-business/shared";
import { customerInputSchema } from "@expendi-business/shared";

export interface CustomerDraft {
  readonly name: string;
  readonly email: string;
  readonly address: string;
  readonly taxId: string;
}

export type CustomerField = keyof CustomerDraft;

export const BLANK_CUSTOMER: CustomerDraft = {
  name: "",
  email: "",
  address: "",
  taxId: "",
};

export const customerDraftOf = (customer: Customer): CustomerDraft => ({
  name: customer.name,
  email: customer.email,
  address: customer.address ?? "",
  taxId: customer.taxId ?? "",
});

export type CustomerResult =
  | { readonly ok: true; readonly input: CustomerInput }
  | {
      readonly ok: false;
      readonly errors: Partial<Record<CustomerField, string>>;
    };

/** Blank optional fields are left out, so they stay empty. */
export function toCustomerInput(draft: CustomerDraft): CustomerResult {
  const parsed = customerInputSchema.safeParse({
    name: draft.name,
    email: draft.email,
    ...(draft.address.trim() === "" ? {} : { address: draft.address }),
    ...(draft.taxId.trim() === "" ? {} : { taxId: draft.taxId }),
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const errors: Partial<Record<CustomerField, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (
      key === "name" ||
      key === "email" ||
      key === "address" ||
      key === "taxId"
    ) {
      errors[key] ??= issue.message;
    }
  }
  return { ok: false, errors };
}

/** What an edit sends: the whole customer, a cleared field as an empty string. */
export function toCustomerUpdate(draft: CustomerDraft): CustomerResult {
  const result = toCustomerInput(draft);
  if (!result.ok) return result;
  return {
    ok: true,
    input: {
      ...result.input,
      address: result.input.address ?? "",
      taxId: result.input.taxId ?? "",
    },
  };
}
