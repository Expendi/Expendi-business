import { describe, expect, it } from "vitest";

import type { PayeeDetails } from "@expendi-business/shared";

import {
  changedRecently,
  detailRows,
  lastFour,
  listSummary,
  matchesSearch,
} from "./payee-display";
import {
  detailFields,
  detailsToValues,
  EMPTY_DETAIL_VALUES,
  fieldLabel,
  methodsForKind,
  validateDetails,
} from "./payee-fields";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

describe("lastFour", () => {
  it.each([
    ["+254712345678", "•••• 5678"],
    ["12345", "•••• 2345"],
    ["1234", "••••"],
    ["", "••••"],
  ])("masks %j as %j", (value, expected) => {
    // #when
    const masked = lastFour(value);

    // #then
    expect(masked).toBe(expected);
  });
});

describe("listSummary", () => {
  it.each<[PayeeDetails | null, string]>([
    [null, "No payment details yet"],
    [
      {
        method: "mpesa_phone",
        phone: "+254712345678",
        accountName: "Jane Wanjiku",
      },
      "M-Pesa number · •••• 5678",
    ],
    [
      { method: "mpesa_till", tillNumber: "123456", accountName: "Duka Ltd" },
      "M-Pesa Till · 123456",
    ],
    [
      {
        method: "mpesa_paybill",
        paybillNumber: "400200",
        accountReference: "ACC-998877",
        accountName: "Kenya Power",
      },
      "M-Pesa Paybill · 400200, account •••• 8877",
    ],
    [
      {
        method: "bank",
        bankCode: "KCBLKENX",
        accountNumber: "1234567890",
        accountName: "Duka Ltd",
      },
      "Bank account · KCBLKENX •••• 7890",
    ],
    [{ method: "usdc", address: ADDRESS }, "USDC wallet · 0x1234…5678"],
    [{ method: "outside" }, "Paid outside Expendi"],
  ])("shows %j as %j", (details, expected) => {
    // #when
    const summary = listSummary({ details, payoutPhoneConfirmed: null }, null);

    // #then
    expect(summary).toBe(expected);
  });

  it("names the bank when its name is known", () => {
    // #given
    const details: PayeeDetails = {
      method: "bank",
      bankCode: "KCBLKENX",
      accountNumber: "1234567890",
      accountName: "Duka Ltd",
    };

    // #when
    const summary = listSummary(
      { details, payoutPhoneConfirmed: null },
      "KCB Bank",
    );

    // #then
    expect(summary).toBe("Bank account · KCB Bank •••• 7890");
  });

  it.each([
    [true, "M-Pesa number · Their confirmed number"],
    [false, "M-Pesa number · Their confirmed number (not confirmed yet)"],
  ])(
    "says whether an employee has confirmed their number (%s)",
    (payoutPhoneConfirmed, expected) => {
      // #when
      const summary = listSummary(
        {
          details: { method: "mpesa_phone", accountName: "Jane Wanjiku" },
          payoutPhoneConfirmed,
        },
        null,
      );

      // #then
      expect(summary).toBe(expected);
    },
  );
});

describe("changedRecently", () => {
  const changedAt = "2026-11-01T10:00:00.000Z";
  const hour = 60 * 60_000;

  it.each([
    [Date.parse(changedAt) + 23 * hour, true],
    [Date.parse(changedAt) + 24 * hour - 1, true],
    [Date.parse(changedAt) + 24 * hour, false],
    [Date.parse(changedAt) + 48 * hour, false],
  ])("is %s at %i", (asOf, expected) => {
    // #when
    const recent = changedRecently(changedAt, asOf);

    // #then
    expect(recent).toBe(expected);
  });

  it.each([null, "not a date"])("is false for %j", (detailsChangedAt) => {
    // #when
    const recent = changedRecently(detailsChangedAt, Date.now());

    // #then
    expect(recent).toBe(false);
  });
});

describe("detailRows", () => {
  const bank: PayeeDetails = {
    method: "bank",
    bankCode: "KCBLKENX",
    accountNumber: "1234567890",
    accountName: "Duka Ltd",
  };

  it("shows every digit for the passkey review", () => {
    // #when
    const rows = detailRows(bank, {
      mask: false,
      bankName: "KCB Bank",
      payoutPhoneConfirmed: null,
    });

    // #then
    expect(rows).toEqual([
      { label: "Paid by", value: "Bank account" },
      { label: "Bank", value: "KCB Bank" },
      { label: "Account number", value: "1234567890" },
      { label: "Account name", value: "Duka Ltd" },
    ]);
  });

  it("masks phone and account numbers but not business numbers", () => {
    // #given
    const paybill: PayeeDetails = {
      method: "mpesa_paybill",
      paybillNumber: "400200",
      accountReference: "ACC-998877",
      accountName: "Kenya Power",
    };

    // #when
    const rows = detailRows(paybill, {
      mask: true,
      bankName: null,
      payoutPhoneConfirmed: null,
    });

    // #then
    expect(rows).toEqual([
      { label: "Paid by", value: "M-Pesa Paybill" },
      { label: "Business number", value: "400200" },
      { label: "Account number", value: "•••• 8877" },
      { label: "Business name", value: "Kenya Power" },
    ]);
  });

  it("keeps a Base address whole", () => {
    // #when
    const rows = detailRows(
      { method: "usdc", address: ADDRESS },
      { mask: true, bankName: null, payoutPhoneConfirmed: null },
    );

    // #then
    expect(rows).toContainEqual({ label: "Base address", value: ADDRESS });
  });

  it("explains an employee's M-Pesa number instead of showing one", () => {
    // #when
    const rows = detailRows(
      { method: "mpesa_phone", accountName: "Jane Wanjiku" },
      { mask: true, bankName: null, payoutPhoneConfirmed: false },
    );

    // #then
    expect(rows).toEqual([
      { label: "Paid by", value: "M-Pesa number" },
      {
        label: "M-Pesa number",
        value: "Their confirmed number (not confirmed yet)",
      },
      { label: "Account name", value: "Jane Wanjiku" },
    ]);
  });
});

describe("matchesSearch", () => {
  it.each([
    ["Kenya Power", "", true],
    ["Kenya Power", "  ", true],
    ["Kenya Power", "power", true],
    ["Kenya Power", " KENYA ", true],
    ["Kenya Power", "water", false],
  ])("%j matches %j: %s", (name, search, expected) => {
    // #then
    expect(matchesSearch(name, search)).toBe(expected);
  });
});

describe("methodsForKind", () => {
  it("limits employees to their confirmed number, a bank or paying outside", () => {
    // #then
    expect(methodsForKind("employee")).toEqual([
      "mpesa_phone",
      "bank",
      "outside",
    ]);
  });

  it("offers every method to everyone else", () => {
    // #then
    expect(methodsForKind("supplier")).toEqual([
      "mpesa_phone",
      "mpesa_till",
      "mpesa_paybill",
      "bank",
      "usdc",
      "outside",
    ]);
  });
});

describe("detailFields", () => {
  it.each([
    ["mpesa_phone", "supplier", ["phone", "accountName"]],
    ["mpesa_phone", "employee", ["accountName"]],
    ["mpesa_till", "vendor", ["tillNumber", "accountName"]],
    [
      "mpesa_paybill",
      "statutory",
      ["paybillNumber", "accountReference", "accountName"],
    ],
    ["bank", "employee", ["bankCode", "accountNumber", "accountName"]],
    ["usdc", "supplier", ["address"]],
    ["outside", "vendor", []],
  ] as const)("asks %s for a %s for %j", (method, kind, expected) => {
    // #then
    expect(detailFields(method, kind)).toEqual(expected);
  });
});

describe("fieldLabel", () => {
  it.each([
    ["mpesa_phone", "accountName", "Account name"],
    ["mpesa_till", "accountName", "Business name"],
    ["mpesa_paybill", "accountName", "Business name"],
    ["mpesa_paybill", "paybillNumber", "Business number"],
    ["bank", "accountName", "Account name"],
  ] as const)("labels %s's %s %j", (method, field, expected) => {
    // #then
    expect(fieldLabel(method, field)).toBe(expected);
  });
});

describe("detailsToValues", () => {
  it("prefills the form from the current details", () => {
    // #when
    const values = detailsToValues({
      method: "mpesa_paybill",
      paybillNumber: "400200",
      accountReference: "ACC-1",
      accountName: "Kenya Power",
    });

    // #then
    expect(values).toEqual({
      ...EMPTY_DETAIL_VALUES,
      paybillNumber: "400200",
      accountReference: "ACC-1",
      accountName: "Kenya Power",
    });
  });

  it("starts empty when there are no details", () => {
    // #then
    expect(detailsToValues(null)).toEqual(EMPTY_DETAIL_VALUES);
  });
});

describe("validateDetails", () => {
  it("sends only the chosen method's fields", () => {
    // #given
    const values = {
      ...EMPTY_DETAIL_VALUES,
      phone: "0712 345 678",
      tillNumber: "12 34 56",
      accountName: "Duka Ltd",
    };

    // #when
    const result = validateDetails("mpesa_till", "supplier", values);

    // #then
    expect(result).toEqual({
      ok: true,
      details: {
        method: "mpesa_till",
        tillNumber: "123456",
        accountName: "Duka Ltd",
      },
    });
  });

  it("leaves an employee's M-Pesa number out", () => {
    // #given
    const values = {
      ...EMPTY_DETAIL_VALUES,
      phone: "0712 345 678",
      accountName: "Jane Wanjiku",
    };

    // #when
    const result = validateDetails("mpesa_phone", "employee", values);

    // #then
    expect(result).toEqual({
      ok: true,
      details: { method: "mpesa_phone", accountName: "Jane Wanjiku" },
    });
  });

  it("asks everyone else for their M-Pesa number", () => {
    // #given
    const values = { ...EMPTY_DETAIL_VALUES, accountName: "Jane Wanjiku" };

    // #when
    const result = validateDetails("mpesa_phone", "personnel", values);

    // #then
    expect(result).toEqual({
      ok: false,
      errors: { phone: "Enter the M-Pesa number." },
    });
  });

  it("puts each message on its field", () => {
    // #given
    const values = {
      ...EMPTY_DETAIL_VALUES,
      paybillNumber: "12",
      accountName: " ",
    };

    // #when
    const result = validateDetails("mpesa_paybill", "statutory", values);

    // #then
    expect(result).toEqual({
      ok: false,
      errors: {
        paybillNumber: "A Paybill number is 5 to 7 digits.",
        accountReference: "Enter the Paybill account number.",
        accountName: "Enter the name on the account.",
      },
    });
  });

  it("needs a bank and a well-formed account number", () => {
    // #given
    const values = {
      ...EMPTY_DETAIL_VALUES,
      accountNumber: "12",
      accountName: "Duka Ltd",
    };

    // #when
    const result = validateDetails("bank", "supplier", values);

    // #then
    expect(result).toEqual({
      ok: false,
      errors: {
        bankCode: "Choose the bank.",
        accountNumber: "A bank account number is 5 to 20 letters and digits.",
      },
    });
  });

  it("refuses a malformed Base address", () => {
    // #given
    const values = { ...EMPTY_DETAIL_VALUES, address: "0x123" };

    // #when
    const result = validateDetails("usdc", "supplier", values);

    // #then
    expect(result).toEqual({
      ok: false,
      errors: { address: "That isn't a Base address." },
    });
  });

  it("needs nothing to pay outside Expendi", () => {
    // #when
    const result = validateDetails("outside", "vendor", EMPTY_DETAIL_VALUES);

    // #then
    expect(result).toEqual({ ok: true, details: { method: "outside" } });
  });
});
