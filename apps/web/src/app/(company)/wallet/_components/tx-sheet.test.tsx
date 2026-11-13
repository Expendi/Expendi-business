import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WalletHistoryItem } from "@expendi-business/shared";

import { LEDGER } from "~/app/dev/preview/_harness/fixtures/wallet";
import {
  pageText,
  RECEIPT_SAMPLES,
  showsReceipt,
} from "~/components/data/payment-receipts.samples";
import { TxDetails } from "./tx-sheet";

const NEAR_HASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOLANA_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function sample(type: WalletHistoryItem["type"], chain: "near" | "base") {
  const item = LEDGER.find((row) => row.type === type && row.chain === chain);
  if (!item) throw new Error(`No sample ${type} on ${chain}`);
  return item;
}

function details(item: WalletHistoryItem): string {
  return renderToStaticMarkup(
    <TxDetails item={item} items={LEDGER} today="2026-11-06" rate="129" />,
  ).replace(/<[^>]+>/g, " ");
}

describe("a movement's details", () => {
  it("shows a NEAR transaction hash as it is written, under its chain", () => {
    // #given
    const deposit = { ...sample("deposit", "near"), txHash: NEAR_HASH };

    // #when
    const page = details(deposit);

    // #then
    expect({
      chain: page.includes("Chain") && page.includes("NEAR"),
      label: page.includes("NEAR transaction"),
      hash: page.includes("9xQeWv…VFin"),
      lowercased: page.includes("9xqewv"),
      sender: page.includes("mwangaza-treasury.near"),
    }).toEqual({
      chain: true,
      label: true,
      hash: true,
      lowercased: false,
      sender: true,
    });
  });

  it("still shows a deposit from before the move as a Base one", () => {
    // #when
    const page = details(sample("deposit", "base"));

    // #then
    expect({
      label: page.includes("Base transaction"),
      hash: page.includes("0x0011…0011"),
      near: page.includes("NEAR"),
    }).toEqual({ label: true, hash: true, near: false });
  });

  it("names the payee chain a withdrawal was paid on", () => {
    // #given a withdrawal to a Solana address, sent from the NEAR wallet
    const withdrawal = sample("withdrawal", "near");
    const toSolana: WalletHistoryItem = {
      ...withdrawal,
      payout: withdrawal.payout && {
        ...withdrawal.payout,
        recipientDetail: SOLANA_ADDRESS,
        recipientChain: "solana",
      },
    };

    // #when
    const pages = [details(withdrawal), details(toSolana)];

    // #then
    expect(
      pages.map((page) => ({
        base: /Payee chain\s+Base/.test(page),
        solana: /Payee chain\s+Solana/.test(page),
        address: page.includes(SOLANA_ADDRESS),
        fee: page.includes("Paid by Expendi"),
      })),
    ).toEqual([
      { base: true, solana: false, address: false, fee: true },
      { base: false, solana: true, address: true, fee: true },
    ]);
  });
});

describe("a paid cash-out's receipt", () => {
  function paidCashOut(): WalletHistoryItem {
    const item = LEDGER.find(
      (row) =>
        row.type === "payout" &&
        row.payout?.status === "paid" &&
        row.payout.method !== "usdc",
    );
    if (!item) throw new Error("No sample paid cash-out");
    return item;
  }

  function withReceipts(
    receipts: (typeof RECEIPT_SAMPLES)[number]["receipts"],
  ): WalletHistoryItem {
    const item = paidCashOut();
    return {
      ...item,
      payout: item.payout && {
        ...item.payout,
        paymentReceipts: [...receipts],
      },
    };
  }

  it.each(RECEIPT_SAMPLES)("shows $name right after Paid", (receipt) => {
    // #when
    const page = pageText(details(withReceipts(receipt.receipts)));

    // #then
    expect(page).toContain(`Paid Yesterday, 11:12 AM ${receipt.reads}`);
  });

  it("shows no receipt row before it's paid", () => {
    // #when
    const page = pageText(details(withReceipts([])));

    // #then
    expect(showsReceipt(page)).toBe(false);
  });
});

describe("a payment's progress", () => {
  function progress(status: "paid" | "failed"): string {
    const paid = LEDGER.find(
      (row) => row.type === "payout" && row.payout?.status === "paid",
    );
    if (!paid?.payout) throw new Error("No sample paid payment");
    const item = { ...paid, payout: { ...paid.payout, status } };
    const page = renderToStaticMarkup(
      <TxDetails item={item} items={LEDGER} today="2026-11-06" rate="129" />,
    );
    return page.slice(
      page.indexOf('<ol aria-label="Payment progress"'),
      page.indexOf("</ol>"),
    );
  }

  it("marks every step of a paid payment green", () => {
    // #when
    const steps = progress("paid");

    // #then
    expect({
      green: steps.split("border-success-700 bg-success-700").length - 1,
      red: steps.includes("error-700"),
    }).toEqual({ green: 4, red: false });
  });

  it("marks the step that failed red and the ones before it green", () => {
    // #when
    const steps = progress("failed");

    // #then
    expect({
      green: steps.split("border-success-700 bg-success-700").length - 1,
      red: steps.includes("border-error-700 bg-error-50 text-error-700"),
      label: steps.includes('text-error-700">Failed'),
    }).toEqual({ green: 2, red: true, label: true });
  });
});
