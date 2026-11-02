import { describe, expect, it } from "vitest";

import type { CompanySpendingDetail } from "@expendi-business/shared";
import {
  recordCompanySpendingRequestSchema,
  updateCompanySpendingRequestSchema,
} from "@expendi-business/shared";

import type { SpendingExtras } from "./spending-draft";
import {
  BLANK_EXTRAS,
  blankSpendingDraft,
  draftFromSpending,
  extrasFromSpending,
  receiptProblem,
  spendingSummary,
  toRecordRequest,
  toUpdateRequest,
} from "./spending-draft";

const KCB = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const UTILITIES = "33333333-3333-4333-8333-333333333333";
const RECEIPT = "44444444-4444-4444-8444-444444444444";
const PROOF = "55555555-5555-4555-8555-555555555555";

function spending(
  overrides: Partial<CompanySpendingDetail> = {},
): CompanySpendingDetail {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    status: "recorded",
    overviewHeading: "transactions",
    merchant: "Kenya Power",
    amountKes: "450000",
    spentOn: "2026-10-20",
    description: "October electricity",
    category: { id: UTILITIES, name: "Utilities" },
    paidFromAccount: {
      id: KCB,
      name: "KCB current account",
      kind: "bank",
      archived: false,
    },
    bill: null,
    mpesaCode: null,
    etimsInvoiceNumber: null,
    etimsSupplierPin: null,
    etimsQrPayload: null,
    etimsStatus: "none",
    noReceipt: false,
    noReceiptReason: null,
    warnings: [],
    receiptCount: 1,
    recordedBy: {
      membershipId: "77777777-7777-4777-8777-777777777777",
      name: "Wanjiku",
      email: "wanjiku@example.com",
    },
    createdAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-20T08:00:00.000Z",
    receipts: [
      {
        id: RECEIPT,
        kind: "photo",
        billRole: null,
        contentType: "image/jpeg",
        url: "https://storage.example/receipt.jpg",
        expiresAt: "2026-10-20T09:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

const filledDraft = {
  ...blankSpendingDraft("2026-10-20"),
  merchant: "Kenya Power",
  amount: "4,500",
  categoryId: UTILITIES,
  description: "October electricity",
};

const extras = (changes: Partial<SpendingExtras> = {}): SpendingExtras => ({
  ...BLANK_EXTRAS,
  paidFromAccountId: KCB,
  ...changes,
});

describe("toRecordRequest", () => {
  it("files new spending under Transactions with its account and receipts", () => {
    // #when
    const request = toRecordRequest(filledDraft, extras(), [RECEIPT]);

    // #then
    expect(request).toMatchObject({
      receiptFileIds: [RECEIPT],
      noReceiptReason: null,
      overviewHeading: "transactions",
      paidFromAccountId: KCB,
      amountKes: "4,500",
    });
    expect(recordCompanySpendingRequestSchema.safeParse(request).success).toBe(
      true,
    );
  });

  it("sends the reason only when saving without a receipt", () => {
    // #given
    const without = extras({
      withoutReceipt: true,
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #when
    const noReceipt = toRecordRequest(filledDraft, without, []);
    const receiptAddedLater = toRecordRequest(filledDraft, without, [RECEIPT]);

    // #then
    expect(noReceipt.noReceiptReason).toBe("Bank charge, no receipt issued");
    expect(receiptAddedLater.noReceiptReason).toBeNull();
  });

  it("leaves the account blank for the schema to ask for one", () => {
    // #when
    const request = toRecordRequest(
      filledDraft,
      extras({ paidFromAccountId: null }),
      [RECEIPT],
    );

    // #then
    const parsed = recordCompanySpendingRequestSchema.safeParse(request);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["paidFromAccountId"]);
  });
});

describe("receiptProblem", () => {
  it("asks for a receipt or a reason", () => {
    // #then
    expect(receiptProblem(0, extras(), { fromBill: false })).toContain(
      "Save without receipt",
    );
    expect(receiptProblem(1, extras(), { fromBill: false })).toBeNull();
    expect(
      receiptProblem(0, extras({ withoutReceipt: true }), { fromBill: false }),
    ).toBeNull();
  });

  it("lets spending from a bill have none", () => {
    // #then
    expect(receiptProblem(0, extras(), { fromBill: true })).toBeNull();
  });
});

describe("toUpdateRequest", () => {
  it("sends the form back as it stands, which the API compares", () => {
    // #given
    const current = spending();
    const draft = { ...draftFromSpending(current), merchant: "KPLC" };

    // #when
    const request = toUpdateRequest(
      current,
      draft,
      extrasFromSpending(current),
      [RECEIPT],
    );

    // #then
    expect(request).toMatchObject({
      merchant: "KPLC",
      amountKes: "4500.00",
      spentOn: "2026-10-20",
      paidFromAccountId: KCB,
      receiptFileIds: [RECEIPT],
    });
    expect(request).not.toHaveProperty("noReceiptReason");
    expect(updateCompanySpendingRequestSchema.safeParse(request).success).toBe(
      true,
    );
  });

  it("keeps a bill's amount and date out of the edit, and counts its files as receipts", () => {
    // #given
    const fromBill = spending({
      bill: {
        id: "88888888-8888-4888-8888-888888888888",
        payee: { id: "99999999-9999-4999-8999-999999999999", name: "Zoom" },
        reference: "INV-1",
        dueOn: "2026-10-18",
      },
      paidFromAccount: null,
      receipts: [
        {
          id: PROOF,
          kind: "pdf",
          billRole: "proof",
          contentType: "application/pdf",
          url: "https://storage.example/proof.pdf",
          expiresAt: "2026-10-20T09:00:00.000Z",
        },
      ],
    });

    // #when
    const request = toUpdateRequest(
      fromBill,
      draftFromSpending(fromBill),
      extras({ paidFromAccountId: CARD, withoutReceipt: true }),
      [],
    );

    // #then
    expect(request).not.toHaveProperty("amountKes");
    expect(request).not.toHaveProperty("spentOn");
    expect(request).not.toHaveProperty("noReceiptReason");
    expect(request.paidFromAccountId).toBe(CARD);
  });

  it("carries a stored no-receipt reason into the form", () => {
    // #given
    const current = spending({
      noReceipt: true,
      noReceiptReason: "Receipt lost in transit",
      receipts: [],
      receiptCount: 0,
    });

    // #when
    const formExtras = extrasFromSpending(current);
    const request = toUpdateRequest(
      current,
      draftFromSpending(current),
      formExtras,
      [],
    );

    // #then
    expect(formExtras).toMatchObject({
      withoutReceipt: true,
      noReceiptReason: "Receipt lost in transit",
    });
    expect(request.noReceiptReason).toBe("Receipt lost in transit");
  });
});

describe("spendingSummary", () => {
  it("shows the date and the account, or that none was given", () => {
    // #then
    expect(spendingSummary(spending())).toBe(
      "20 Oct 2026 · KCB current account",
    );
    expect(spendingSummary(spending({ paidFromAccount: null }))).toBe(
      "20 Oct 2026 · Account not specified",
    );
  });
});
