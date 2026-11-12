import { describe, expect, it } from "vitest";

import {
  BLANK_CUSTOMER,
  customerDraftOf,
  toCustomerInput,
  toCustomerUpdate,
} from "./customer-draft";

describe("a customer draft", () => {
  it("leaves blank optional fields out of a new customer", () => {
    // #when
    const result = toCustomerInput({
      ...BLANK_CUSTOMER,
      name: " Acme Ltd ",
      email: "ap@acme.co.ke",
      taxId: "P051234567X",
    });

    // #then
    expect(result).toEqual({
      ok: true,
      input: { name: "Acme Ltd", email: "ap@acme.co.ke", taxId: "P051234567X" },
    });
  });

  it("sends a cleared address or tax ID as an empty string when editing", () => {
    // #when
    const result = toCustomerUpdate({
      ...BLANK_CUSTOMER,
      name: "Acme Ltd",
      email: "ap@acme.co.ke",
    });

    // #then
    expect(result).toEqual({
      ok: true,
      input: {
        name: "Acme Ltd",
        email: "ap@acme.co.ke",
        address: "",
        taxId: "",
      },
    });
  });

  it("names the name and email when they are wrong", () => {
    // #when
    const result = toCustomerInput({ ...BLANK_CUSTOMER, email: "nope" });

    // #then
    expect(result).toEqual({
      ok: false,
      errors: {
        name: "Enter the customer's name.",
        email: "Enter a valid email address.",
      },
    });
  });

  it("starts an edit from the saved customer", () => {
    // #then
    expect(
      customerDraftOf({
        id: "00000000-0000-4000-8000-000000000101",
        name: "Acme Ltd",
        email: "ap@acme.co.ke",
        address: null,
        taxId: "P0512",
        archived: false,
        createdAt: "2026-10-01T09:00:00.000Z",
      }),
    ).toEqual({
      name: "Acme Ltd",
      email: "ap@acme.co.ke",
      address: "",
      taxId: "P0512",
    });
  });
});
