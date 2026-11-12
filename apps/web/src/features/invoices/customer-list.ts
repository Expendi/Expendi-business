import type { Customer } from "@expendi-business/shared";

/** Which customers the list shows: active ones unless the filter says otherwise. */
export type CustomerShow = "active" | "archived" | "all";

export function customerShowOf(value: string | null): CustomerShow {
  return value === "archived" || value === "all" ? value : "active";
}

export function filterCustomers(
  customers: readonly Customer[],
  show: CustomerShow,
): Customer[] {
  return customers.filter(
    (customer) => show === "all" || customer.archived === (show === "archived"),
  );
}
