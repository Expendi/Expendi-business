import { describe, expect, it } from "vitest";

import type { Customer } from "@expendi-business/shared";

import { customerShowOf, filterCustomers } from "./customer-list";

const customer = (name: string, archived: boolean): Customer => ({
  id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, "0")}`,
  name,
  email: `${name}@example.com`,
  address: null,
  taxId: null,
  archived,
  createdAt: "2026-10-01T09:00:00.000Z",
});

describe("the customers list filter", () => {
  const all = [customer("Acme", false), customer("Zed", true)];

  it("shows active customers unless asked for archived ones or all", () => {
    // #then
    expect({
      active: filterCustomers(all, "active").map((c) => c.name),
      archived: filterCustomers(all, "archived").map((c) => c.name),
      everyone: filterCustomers(all, "all").map((c) => c.name),
    }).toEqual({
      active: ["Acme"],
      archived: ["Zed"],
      everyone: ["Acme", "Zed"],
    });
  });

  it("reads the URL value, falling back to active", () => {
    // #then
    expect([null, "archived", "all", "nonsense"].map(customerShowOf)).toEqual([
      "active",
      "archived",
      "all",
      "active",
    ]);
  });
});
