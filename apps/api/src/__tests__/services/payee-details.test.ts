import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { PayeeDetails, PayeeKind } from "@expendi-business/shared";
import { payeeDetailsSchema } from "@expendi-business/shared";

import {
  checkBank,
  checkDetailsForKind,
  maskDetails,
  normaliseDetails,
} from "../../services/payees/details.js";
import { makeFakePaycrest } from "../helpers/fakes.js";

type Outcome<A> = { readonly ok: A } | { readonly error: string };

function outcomeOf<A, E extends { readonly _tag: string }>(
  exit: Exit.Exit<A, E>,
): Outcome<A> {
  if (Exit.isSuccess(exit)) return { ok: exit.value };
  const failure = Cause.failureOption(exit.cause);
  return { error: Option.isSome(failure) ? failure.value._tag : "defect" };
}

/** The shared schema the route parses with, then the API's normalisation. */
function validate(raw: unknown): Outcome<PayeeDetails> | "rejected by schema" {
  const parsed = payeeDetailsSchema.safeParse(raw);
  if (!parsed.success) return "rejected by schema";
  return outcomeOf(Effect.runSyncExit(normaliseDetails(parsed.data)));
}

const forKind = (kind: PayeeKind, details: PayeeDetails) =>
  outcomeOf(Effect.runSyncExit(checkDetailsForKind(kind, details)));

const accountName = "Jane Wanjiku";

describe("payee payment details", () => {
  describe("M-Pesa number", () => {
    it("normalises a Kenyan number to E.164", () => {
      // #when
      const result = validate({
        method: "mpesa_phone",
        phone: "0712 345 678",
        accountName: "  Jane   Wanjiku ",
      });

      // #then
      expect(result).toEqual({
        ok: { method: "mpesa_phone", phone: "+254712345678", accountName },
      });
    });

    it("accepts the 01xx range", () => {
      // #when
      const result = validate({
        method: "mpesa_phone",
        phone: "+254 112 345 678",
        accountName,
      });

      // #then
      expect(result).toEqual({
        ok: { method: "mpesa_phone", phone: "+254112345678", accountName },
      });
    });

    it.each([
      ["a Tanzanian number", "+255712345678"],
      ["a Nairobi landline", "020 2345678"],
      ["letters", "07I2345678"],
    ])("rejects %s", (_case, phone) => {
      // #when
      const result = validate({ method: "mpesa_phone", phone, accountName });

      // #then
      expect(result).toEqual({ error: "BadRequest" });
    });

    it("leaves the number out for an employee, who is paid to their confirmed one", () => {
      // #when
      const result = validate({ method: "mpesa_phone", accountName });

      // #then
      expect(result).toEqual({ ok: { method: "mpesa_phone", accountName } });
    });
  });

  describe("Till", () => {
    it("accepts 5 to 7 digits, ignoring spaces", () => {
      // #when
      const result = validate({
        method: "mpesa_till",
        tillNumber: "123 456",
        accountName: "Mama Mboga Stores",
      });

      // #then
      expect(result).toEqual({
        ok: {
          method: "mpesa_till",
          tillNumber: "123456",
          accountName: "Mama Mboga Stores",
        },
      });
    });

    it.each([["1234"], ["12345678"], ["12a456"], [""]])(
      "rejects %j",
      (tillNumber) => {
        // #when
        const result = validate({
          method: "mpesa_till",
          tillNumber,
          accountName,
        });

        // #then
        expect(result).toBe("rejected by schema");
      },
    );
  });

  describe("Paybill", () => {
    it("accepts a business number with an account number", () => {
      // #when
      const result = validate({
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: " ACC-1234 ",
        accountName: "Kenya Power",
      });

      // #then
      expect(result).toEqual({
        ok: {
          method: "mpesa_paybill",
          paybillNumber: "888880",
          accountReference: "ACC-1234",
          accountName: "Kenya Power",
        },
      });
    });

    it("rejects a business number that isn't numeric", () => {
      // #when
      const result = validate({
        method: "mpesa_paybill",
        paybillNumber: "88888O",
        accountReference: "ACC-1234",
        accountName,
      });

      // #then
      expect(result).toBe("rejected by schema");
    });

    it("rejects an account number Paycrest can't carry", () => {
      // #when
      const result = validate({
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: "ACC$1234",
        accountName,
      });

      // #then
      expect(result).toEqual({ error: "BadRequest" });
    });

    it("needs the account number", () => {
      // #when
      const result = validate({
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountName,
      });

      // #then
      expect(result).toBe("rejected by schema");
    });
  });

  describe("bank account", () => {
    it("accepts a bank code and an account number", () => {
      // #when
      const result = validate({
        method: "bank",
        bankCode: "KCBLKENX",
        accountNumber: "0123 4567 89",
        accountName,
      });

      // #then
      expect(result).toEqual({
        ok: {
          method: "bank",
          bankCode: "KCBLKENX",
          accountNumber: "0123456789",
          accountName,
        },
      });
    });

    it.each([["1234"], ["0123-456789"], ["123456789012345678901"]])(
      "rejects the account number %j",
      (accountNumber) => {
        // #when
        const result = validate({
          method: "bank",
          bankCode: "KCBLKENX",
          accountNumber,
          accountName,
        });

        // #then
        expect(result).toBe("rejected by schema");
      },
    );

    const bankCheck = async (bankCode: string, paycrest = makeFakePaycrest()) =>
      outcomeOf(
        await Effect.runPromiseExit(
          checkBank({
            method: "bank",
            bankCode,
            accountNumber: "0123456789",
            accountName,
          }).pipe(Effect.provide(paycrest.layer)),
        ),
      );

    it("names a bank on Paycrest's list", async () => {
      // #when
      const result = await bankCheck("EQBLKENA");

      // #then
      expect(result).toEqual({ ok: "Equity Bank" });
    });

    it.each([
      ["a code Paycrest doesn't list", "NOTABANK"],
      ["M-Pesa, which isn't a bank", "SAFAKEPC"],
    ])("rejects %s", async (_case, bankCode) => {
      // #when
      const result = await bankCheck(bankCode);

      // #then
      expect(result).toEqual({ error: "BadRequest" });
    });
  });

  describe("USDC", () => {
    it("accepts a checksummed Base address and stores it lowercased", () => {
      // #when
      const result = validate({
        method: "usdc",
        address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      });

      // #then
      expect(result).toEqual({
        ok: {
          method: "usdc",
          address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        },
      });
    });

    it("rejects an address whose checksum shows a typo", () => {
      // #when one letter's case is flipped
      const result = validate({
        method: "usdc",
        address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd",
      });

      // #then
      expect(result).toEqual({ error: "BadRequest" });
    });

    it.each([
      ["0x1234"],
      ["5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"],
      ["0xzz"],
    ])("rejects %j", (address) => {
      // #when
      const result = validate({ method: "usdc", address });

      // #then
      expect(result).toBe("rejected by schema");
    });
  });

  describe("paid outside Expendi", () => {
    it("keeps no details", () => {
      // #when
      const result = validate({ method: "outside", phone: "0712345678" });

      // #then
      expect(result).toEqual({ ok: { method: "outside" } });
    });
  });

  it.each([
    [{ method: "mpesa_phone", phone: "0712345678" }],
    [{ method: "mpesa_till", tillNumber: "123456" }],
    [
      {
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: "A1",
      },
    ],
    [{ method: "bank", bankCode: "KCBLKENX", accountNumber: "0123456789" }],
    [{ method: "mpesa_till", tillNumber: "123456", accountName: "   " }],
  ])("needs an account name for every KES method: %j", (details) => {
    // #when
    const result = validate(details);

    // #then
    expect(result).toBe("rejected by schema");
  });

  it.each([
    { method: "mpesa_phone", phone: "+254712345678", accountName },
    { method: "mpesa_till", tillNumber: "123456", accountName },
    {
      method: "mpesa_paybill",
      paybillNumber: "888880",
      accountReference: "ACC 12",
      accountName,
    },
    {
      method: "bank",
      bankCode: "KCBLKENX",
      accountNumber: "0123456789",
      accountName,
    },
    { method: "usdc", address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" },
    { method: "outside" },
  ])("normalises $method to itself, so its hash is stable", (details) => {
    // #when
    const once = validate(details);
    const twice =
      once !== "rejected by schema" && "ok" in once ? validate(once.ok) : once;

    // #then
    expect(twice).toEqual(once);
  });

  describe("by kind", () => {
    it.each<[PayeeKind, PayeeDetails]>([
      ["employee", { method: "mpesa_phone", accountName }],
      [
        "employee",
        {
          method: "bank",
          bankCode: "KCBLKENX",
          accountNumber: "0123456789",
          accountName,
        },
      ],
      ["employee", { method: "outside" }],
      [
        "personnel",
        { method: "mpesa_phone", phone: "+254712345678", accountName },
      ],
      ["supplier", { method: "mpesa_till", tillNumber: "123456", accountName }],
    ])("allows a %s to be paid by %j", (kind, details) => {
      // #when
      const result = forKind(kind, details);

      // #then
      expect(result).toEqual({ ok: undefined });
    });

    it.each<[string, PayeeKind, PayeeDetails]>([
      [
        "an employee paid to a number that isn't their confirmed one",
        "employee",
        { method: "mpesa_phone", phone: "+254712345678", accountName },
      ],
      [
        "an employee paid to a Till",
        "employee",
        { method: "mpesa_till", tillNumber: "123456", accountName },
      ],
      [
        "an employee paid in USDC",
        "employee",
        {
          method: "usdc",
          address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        },
      ],
      [
        "personnel on M-Pesa without a number",
        "personnel",
        { method: "mpesa_phone", accountName },
      ],
    ])("refuses %s", (_case, kind, details) => {
      // #when
      const result = forKind(kind, details);

      // #then
      expect(result).toEqual({ error: "BadRequest" });
    });
  });

  describe("masking for the audit log", () => {
    it("shows only the last 4 digits of phone and account numbers", () => {
      // #when
      const masked = [
        maskDetails({
          method: "mpesa_phone",
          phone: "+254712345678",
          accountName,
        }),
        maskDetails({
          method: "bank",
          bankCode: "KCBLKENX",
          accountNumber: "0123456789",
          accountName,
        }),
        maskDetails({
          method: "mpesa_paybill",
          paybillNumber: "888880",
          accountReference: "ACC-1234",
          accountName,
        }),
      ];

      // #then
      expect(masked).toEqual([
        { method: "mpesa_phone", phone: "****5678", accountName },
        {
          method: "bank",
          bankCode: "KCBLKENX",
          accountNumber: "****6789",
          accountName,
        },
        {
          method: "mpesa_paybill",
          paybillNumber: "888880",
          accountReference: "****1234",
          accountName,
        },
      ]);
    });

    it("hides a value of 4 characters or fewer entirely", () => {
      // #when
      const masked = maskDetails({
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: "A12",
        accountName,
      });

      // #then
      expect(masked).toMatchObject({ accountReference: "****" });
    });
  });
});
