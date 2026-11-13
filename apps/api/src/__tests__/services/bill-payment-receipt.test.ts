import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { NewBill } from "../../db/schema/index.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import {
  getBillPaymentReceiptData,
  nairobiDateTime,
  receiptNumberOf,
  renderBillPaymentReceiptPdf,
} from "../../services/bills/payment-receipt.js";
import { nairobiDate } from "../../services/bills/status.js";
import {
  insertBill,
  insertBillPayment,
  insertPayee,
} from "../helpers/bills.js";
import { addCategory } from "../helpers/claims.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const NEAR_HASH = "6mKzv7RfQ9cYw2PqL8nXbT3jDe4HsUa1VgCoNiEp5MtY";

let runtime: AppRuntime;
let db: Database;
let company: TestCompany;
let wallet: TestWallet;
let categoryId: string;
let payeeId: string;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  company = await createCompany(db, "Acme Logistics");
  wallet = await createActiveWallet(db, company);
  categoryId = await addCategory(db, company, "Utilities");
  payeeId = await insertPayee(db, company, { name: "Kenya Power" });
});

const tenantOf = (target: TestCompany): Tenant => ({
  organizationId: target.organizationId,
  userId: target.admin.id,
  membershipId: target.adminMembershipId,
  role: "admin",
});

function bill(values: Partial<NewBill> = {}) {
  return insertBill(db, company, {
    payeeId,
    categoryId,
    reference: "INV-0042",
    notes: "October electricity",
    dueOn: nairobiDate(new Date()),
    status: "due",
    ...values,
  });
}

const receiptOf = (billId: string, target: TestCompany = company) =>
  runtime.runPromise(getBillPaymentReceiptData(tenantOf(target), billId));

async function drawn(billId: string): Promise<string[]> {
  const data = await receiptOf(billId);
  const texts: string[] = [];
  await renderBillPaymentReceiptPdf(data, {
    compress: false,
    onText: (text) => texts.push(text),
  });
  return texts;
}

describe("getBillPaymentReceiptData", () => {
  it("gathers the company, payee, bill, category, amounts, codes and transaction of a paid bill", async () => {
    // #given
    const billId = await bill();
    const payoutId = await insertBillPayment(db, company, wallet.id, billId);

    // #when
    const data = await receiptOf(billId);

    // #then
    expect(data).toMatchObject({
      receiptNumber: receiptNumberOf(payoutId),
      companyName: "Acme Logistics",
      payeeName: "Kenya Power",
      reference: "INV-0042",
      description: "October electricity",
      categoryName: "Utilities",
      amountKesCents: 250_000n,
      usdcSent: 19_430_000n,
      rate: "128.68",
      method: "mpesa_till",
      recipientDetail: "Till 123456",
      providerReceipts: [{ kind: "mpesa", code: "UKDCW299LW" }],
      txHash: NEAR_HASH,
      txChain: "near",
    });
  });

  it("refuses a bill that was paid outside Expendi", async () => {
    // #given
    const billId = await bill({
      status: "paid_outside",
      paidOn: "2026-11-12",
      paidAt: new Date("2026-11-12T09:00:00Z"),
      markedPaidBy: company.admin.id,
    });

    // #when
    const error = await runtime.runPromise(
      getBillPaymentReceiptData(tenantOf(company), billId).pipe(Effect.flip),
    );

    // #then
    expect(error).toMatchObject({
      _tag: "Conflict",
      message:
        "This bill wasn't paid through Expendi, so there's no payment receipt.",
    });
  });

  it.each(["paying", "failed", "needs_review"] as const)(
    "refuses a bill whose payout is %s",
    async (status) => {
      // #given
      const billId = await bill();
      await insertBillPayment(db, company, wallet.id, billId, { status });

      // #when
      const error = await runtime.runPromise(
        getBillPaymentReceiptData(tenantOf(company), billId).pipe(Effect.flip),
      );

      // #then
      expect(error).toMatchObject({ _tag: "Conflict" });
    },
  );

  it("answers not found for another company's bill", async () => {
    // #given
    const billId = await bill();
    await insertBillPayment(db, company, wallet.id, billId);
    const other = await createCompany(db, "Other Co");

    // #when
    const error = await runtime.runPromise(
      getBillPaymentReceiptData(tenantOf(other), billId).pipe(Effect.flip),
    );

    // #then
    expect(error).toMatchObject({ _tag: "NotFound" });
  });
});

describe("renderBillPaymentReceiptPdf", () => {
  it("draws the title, number, payee, category, amounts, rate, method, times, codes, transaction and footer", async () => {
    // #given
    const billId = await bill();
    const payoutId = await insertBillPayment(db, company, wallet.id, billId);

    // #when
    const texts = await drawn(billId);

    // #then
    expect(texts).toEqual(
      expect.arrayContaining([
        "Payment receipt",
        receiptNumberOf(payoutId),
        "Acme Logistics",
        "Kenya Power",
        "INV-0042",
        "October electricity",
        "Utilities",
        "KES 2,500.00",
        "19.43 USDC",
        "KES 128.68 per USDC",
        "M-Pesa Till",
        "13 Nov 2026, 7:30 AM",
        "13 Nov 2026, 7:31 AM",
        "M-Pesa receipt",
        "UKDCW299LW",
        NEAR_HASH,
        "Paid through Expendi Business.",
      ]),
    );
  });

  it("masks a phone number and a bank account to their last four digits", async () => {
    // #given
    const phoneBill = await bill();
    await insertBillPayment(db, company, wallet.id, phoneBill, {
      method: "mpesa_phone",
      recipient: {
        method: "mpesa_phone",
        phone: "+254712345678",
        accountName: "Jane Wanjiku",
      },
    });
    const bankBill = await bill();
    await insertBillPayment(db, company, wallet.id, bankBill, {
      method: "bank",
      providerReference: "KCB-88213",
      recipient: {
        method: "bank",
        bankCode: "KCB",
        accountNumber: "1234567890",
        accountName: "Jane Wanjiku",
      },
    });

    // #when
    const phone = await drawn(phoneBill);
    const bank = await drawn(bankBill);

    // #then
    expect(phone).toContain("•••• 5678");
    expect(bank).toContain("KCB •••• 7890");
    expect(bank).toContain("Bank reference");
    expect(phone.join(" ")).not.toContain("712345678");
    expect(bank.join(" ")).not.toContain("1234567890");
  });

  it("leaves out the rows it has nothing for", async () => {
    // #given
    const billId = await bill({ reference: null, notes: null });
    await insertBillPayment(db, company, wallet.id, billId, {
      rate: null,
      providerReference: null,
    });

    // #when
    const texts = await drawn(billId);

    // #then
    expect(texts).not.toContain("Reference");
    expect(texts).not.toContain("Description");
    expect(texts).not.toContain("Rate");
    expect(texts).not.toContain("M-Pesa receipt");
  });

  it("is a PDF on one A4 page", async () => {
    // #given
    const billId = await bill();
    await insertBillPayment(db, company, wallet.id, billId);
    const data = await receiptOf(billId);

    // #when
    const bytes = await renderBillPaymentReceiptPdf(data, { compress: false });

    // #then
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("/MediaBox [0 0 595.28 841.89]");
  });
});

describe("nairobiDateTime", () => {
  it("writes Nairobi time with AM or PM, whatever the server's zone", () => {
    // #given
    const lateEvening = new Date("2026-11-13T21:05:00Z");
    const noon = new Date("2026-11-13T09:00:00Z");

    // #when
    const written = [lateEvening, noon].map(nairobiDateTime);

    // #then
    expect(written).toEqual(["14 Nov 2026, 12:05 AM", "13 Nov 2026, 12:00 PM"]);
  });
});
