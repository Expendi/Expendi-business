import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  BillPayment,
  BillPaymentResult,
  PayeeChangeHold,
} from "@expendi-business/shared";

import {
  PaymentHold,
  PaymentResultBanner,
  PaymentReview,
} from "./bill-payment-review";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const payment: BillPayment = {
  challengeId: id(900),
  options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
  bills: [
    {
      billId: id(1),
      payoutId: id(101),
      payeeName: "Kilimani Properties",
      paidTo: {
        method: "mpesa_paybill",
        label: "Paybill 522522, account KP-1182",
      },
      currency: "kes",
      billedKes: "4850000",
      receivesKes: "4850000",
      receivesUsdc: null,
      kesEquivalent: "4850000",
      rate: "129",
      usdc: "375968992",
      feeAllowanceUsdc: "3759690",
      maxDebitUsdc: "379728682",
    },
    {
      billId: id(4),
      payoutId: id(104),
      payeeName: "Figma",
      paidTo: { method: "usdc", label: "0x7f2e…b9c4" },
      currency: "usd",
      billedKes: null,
      receivesKes: null,
      receivesUsdc: "45000000",
      kesEquivalent: "580500",
      rate: "129",
      usdc: "45000000",
      feeAllowanceUsdc: "0",
      maxDebitUsdc: "45000000",
    },
  ],
  totals: {
    receivesKes: "4850000",
    receivesUsdc: "45000000",
    kesEquivalent: "5430500",
    usdc: "420968992",
    feeAllowanceUsdc: "3759690",
    maxDebitUsdc: "424728682",
  },
  wallet: { availableUsdc: "16420800000", shortfallUsdc: "0", topUpKes: null },
};

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

function review(
  overrides: Partial<Parameters<typeof PaymentReview>[0]> = {},
): string {
  return textOf(
    renderToStaticMarkup(
      <PaymentReview
        payment={payment}
        paying={false}
        costChanged={false}
        cancelled={false}
        footerSlot={null}
        onPay={() => undefined}
        onCancel={() => undefined}
        {...overrides}
      />,
    ),
  );
}

describe("reviewing a payment", () => {
  it("shows each bill's payment, the totals and the passkey step", () => {
    // #when
    const text = review();

    // #then
    expect(
      [
        "Kilimani Properties Paybill 522522, account KP-1182 KES 48,500",
        "Figma 0x7f2e…b9c4 45.00 USDC",
        "They receive 45.00 USDC, exactly",
        "Paid in KES KES 48,500.00",
        "Total from the wallet, at most 424.728682 USDC",
        "One passkey confirmation pays them all",
        "use a phone or tablet",
        "Pay with passkey",
        "Cancel",
      ].filter((part) => !text.includes(part)),
    ).toEqual([]);
  });

  it("asks for a top-up instead when the wallet is short, says when the cost changed, and when the passkey was cancelled", () => {
    // #when
    const short = review({
      payment: {
        ...payment,
        wallet: {
          availableUsdc: "18400000",
          shortfallUsdc: "406328682",
          topUpKes: "5241700",
        },
      },
    });
    const changed = review({ costChanged: true, cancelled: true });

    // #then
    expect({
      topUp: short.includes("Top up KES 52,417"),
      accounts: short.includes("Go to Accounts"),
      passkeyHint: short.includes("use a phone or tablet"),
      costChanged: changed.includes(
        "The cost changed since you reviewed it. Nothing was sent. Review it again.",
      ),
      cancelled: changed.includes("Cancelled. Nothing was sent."),
    }).toEqual({
      topUp: true,
      accounts: true,
      passkeyHint: false,
      costChanged: true,
      cancelled: true,
    });
  });

  it("asks the admin to check recently changed payment details first", () => {
    // #given
    const hold: PayeeChangeHold = {
      reason: "payee_details_changed",
      payees: [
        {
          payeeId: id(109),
          name: "Bidco Kenya",
          detailsChangedAt: "2026-11-06T06:00:00.000Z",
        },
      ],
    };

    // #when
    const html = renderToStaticMarkup(
      <PaymentHold
        hold={hold}
        preparing={false}
        footerSlot={null}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // #then
    expect({
      warning: textOf(html).includes(
        "Bidco Kenya had their payment details changed in the last 24 hours.",
      ),
      confirm: textOf(html).includes(
        "I’ve checked the new payment details and want to pay anyway",
      ),
      continueDisabled: /<button[^>]*disabled=""[^>]*>Continue/.test(html),
    }).toEqual({ warning: true, confirm: true, continueDisabled: true });
  });
});

describe("a payment's result", () => {
  const banner = (result: BillPaymentResult) =>
    textOf(
      renderToStaticMarkup(
        <PaymentResultBanner
          result={result}
          showBeingPaid
          onRetry={() => undefined}
          onSeeBeingPaid={() => undefined}
          onDismiss={() => undefined}
        />,
      ),
    );

  it("says the payments were sent, with a way to Being paid", () => {
    // #when
    const text = banner({
      bills: payment.bills.map((preview) => ({
        billId: preview.billId,
        status: "paying",
        payout: { id: preview.payoutId, status: "paying", failureReason: null },
      })),
    });

    // #then
    expect({
      title: text.includes("Payments sent"),
      beingPaid: text.includes("See Being paid"),
      retry: text.includes("Retry"),
    }).toEqual({ title: true, beingPaid: true, retry: false });
  });

  it("names why one payment failed and offers to retry it", () => {
    // #when
    const text = banner({
      bills: [
        {
          billId: id(1),
          status: "payout_failed",
          payout: {
            id: id(101),
            status: "failed",
            failureReason: "The paybill didn't accept the account number.",
          },
        },
        {
          billId: id(4),
          status: "paying",
          payout: { id: id(104), status: "paying", failureReason: null },
        },
      ],
    });

    // #then
    expect({
      title: text.includes("A payment failed"),
      reason: text.includes(
        "The paybill didn&#x27;t accept the account number.",
      ),
      retry: text.includes("Retry the failed payment"),
      beingPaid: text.includes("See Being paid"),
    }).toEqual({ title: true, reason: true, retry: true, beingPaid: false });
  });
});
