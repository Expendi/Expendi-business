import { describe, expect, it } from "vitest";

import type { Payee, Salary } from "@expendi-business/shared";
import {
  createSalaryRequestSchema,
  updateSalaryRequestSchema,
} from "@expendi-business/shared";

import {
  blankSalaryDraft,
  canBePaidSalary,
  capRoom,
  draftFromSalary,
  payDayInWords,
  salaryPayees,
  toCreateSalaryRequest,
  toUpdateSalaryRequest,
} from "./payroll-display";

function salary(overrides: Partial<Salary> = {}): Salary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    state: "active",
    payee: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Amina",
      kind: "employee",
      method: "mpesa_phone",
      archived: false,
      payoutPhoneConfirmed: true,
      accountEnding: null,
    },
    category: { id: "22222222-2222-4222-8222-222222222222", name: "Salaries" },
    amountKes: "5000000",
    payDay: 28,
    startsOn: "2026-11-01",
    endsOn: null,
    nextPayDate: "2026-11-28",
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    ...overrides,
  };
}

function payee(overrides: Partial<Payee> = {}): Payee {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "employee",
    name: "Brian",
    membershipId: "44444444-4444-4444-8444-444444444444",
    details: { method: "mpesa_phone", accountName: "Brian" },
    payoutPhoneConfirmed: true,
    detailsChangedAt: null,
    secondConfirmationUntil: null,
    archived: false,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("capRoom", () => {
  it("is the room left under the cap", () => {
    expect(capRoom({ totalKes: "10000000", capKes: "12000000" })).toEqual({
      overCap: false,
      cents: "2000000",
    });
  });

  it("says by how much a run is over its cap", () => {
    expect(capRoom({ totalKes: "12500050", capKes: "12000000" })).toEqual({
      overCap: true,
      cents: "500050",
    });
  });
});

describe("payDayInWords", () => {
  it.each([
    [1, "The 1st of each month"],
    [22, "The 22nd of each month"],
    [28, "The 28th of each month"],
    [31, "The 31st of each month, or the month’s last day"],
  ])("describes the %s", (payDay, words) => {
    expect(payDayInWords(payDay)).toBe(words);
  });
});

describe("salaryPayees", () => {
  it("offers employees and personnel who aren't archived", () => {
    // #given
    const payees = [
      payee({ name: "Employee" }),
      payee({ name: "Casual", kind: "personnel", membershipId: null }),
      payee({ name: "Supplier", kind: "supplier", membershipId: null }),
      payee({ name: "Gone", archived: true }),
    ];

    // #then
    expect(salaryPayees(payees).map((each) => each.name)).toEqual([
      "Employee",
      "Casual",
    ]);
  });

  it.each([
    [{ method: "mpesa_phone", accountName: "Brian" } as const, true],
    [
      {
        method: "bank",
        bankCode: "EQBLKENA",
        accountNumber: "0123456789",
        accountName: "Brian",
      } as const,
      true,
    ],
    [{ method: "outside" } as const, false],
    [null, false],
  ])("knows whether %j can be paid a salary", (details, payable) => {
    expect(canBePaidSalary(payee({ details }))).toBe(payable);
  });
});

describe("the salary form", () => {
  it("sends what the API accepts for a new salary", () => {
    // #given
    const draft = {
      ...blankSalaryDraft("2026-11-02"),
      payeeId: "33333333-3333-4333-8333-333333333333",
      amount: "45,000.50",
      payDay: "31",
      categoryId: "22222222-2222-4222-8222-222222222222",
    };

    // #when
    const parsed = createSalaryRequestSchema.parse(
      toCreateSalaryRequest(draft),
    );

    // #then
    expect(parsed).toEqual({
      payeeId: "33333333-3333-4333-8333-333333333333",
      amountKes: 4_500_050n,
      payDay: 31,
      startsOn: "2026-11-02",
      categoryId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("refuses a pay day that isn't a day of the month", () => {
    // #given
    const draft = { ...draftFromSalary(salary()), payDay: "32" };

    // #then
    expect(
      createSalaryRequestSchema.safeParse(toCreateSalaryRequest(draft)).success,
    ).toBe(false);
  });

  it("sends only what changed on an edit", () => {
    // #given
    const draft = { ...draftFromSalary(salary()), payDay: "25", amount: "1" };

    // #then
    expect(toUpdateSalaryRequest(salary(), draft)).toEqual({ payDay: 25 });
  });

  it("sends nothing the API would take when nothing changed", () => {
    // #given
    const request = toUpdateSalaryRequest(salary(), draftFromSalary(salary()));

    // #then
    expect(updateSalaryRequestSchema.safeParse(request).success).toBe(false);
  });
});
