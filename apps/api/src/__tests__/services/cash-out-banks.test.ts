import { describe, expect, it } from "vitest";

import {
  bankByCode,
  CASH_OUT_BANKS,
  listCashOutBanks,
  providerBankCode,
  providerCanPayBank,
} from "../../services/cash-out/banks.js";

describe("the cash-out bank catalogue", () => {
  it("keeps Paycrest's 40 KES banks, one entry per code", () => {
    const codes = CASH_OUT_BANKS.map((bank) => bank.code);
    expect({ count: codes.length, unique: new Set(codes).size }).toEqual({
      count: 40,
      unique: 40,
    });
  });

  it("has Pretium's code for exactly the 20 banks matched to its list, each unique", () => {
    const pretiumCodes = CASH_OUT_BANKS.flatMap((bank) =>
      bank.pretiumCode === null ? [] : [bank.pretiumCode],
    );
    expect({
      count: pretiumCodes.length,
      unique: new Set(pretiumCodes).size,
    }).toEqual({ count: 20, unique: 20 });
  });

  it("lists each bank's code and name for the picker", () => {
    expect(listCashOutBanks()).toContainEqual({
      code: "EQBLKENA",
      name: "Equity Bank",
    });
  });

  it("names I&M Bank as customers search for it", () => {
    expect(bankByCode("IMBLKENA")).toEqual({
      code: "IMBLKENA",
      name: "I&M Bank",
      pretiumCode: "542542",
    });
  });

  it("finds a bank by the code payees store", () => {
    expect([bankByCode("KCBLKENX")?.name, bankByCode("NOPE")]).toEqual([
      "Kenya Commercial Bank",
      null,
    ]);
  });

  it("gives Paycrest the stored code itself", () => {
    expect([
      providerBankCode("paycrest", "EQBLKENA"),
      providerCanPayBank("paycrest", "EQBLKENA"),
    ]).toEqual(["EQBLKENA", true]);
  });

  it("lets Paycrest pay every catalogue bank", () => {
    expect(
      CASH_OUT_BANKS.filter(
        (bank) => !providerCanPayBank("paycrest", bank.code),
      ),
    ).toEqual([]);
  });

  it("gives Pretium its own code for a bank on its list", () => {
    expect([
      providerBankCode("pretium", "EQBLKENA"),
      providerCanPayBank("pretium", "EQBLKENA"),
    ]).toEqual(["247247", true]);
  });

  it("can't send a cash-out through Pretium to a bank it doesn't list", () => {
    expect([
      providerBankCode("pretium", "PRIEKENX"),
      providerCanPayBank("pretium", "PRIEKENX"),
    ]).toEqual([null, false]);
  });

  it("knows no bank outside the catalogue, for any provider", () => {
    expect([
      providerBankCode("paycrest", "SAFAKEPC"),
      providerCanPayBank("paycrest", "SAFAKEPC"),
      providerBankCode("pretium", "SAFAKEPC"),
    ]).toEqual([null, false, null]);
  });
});
