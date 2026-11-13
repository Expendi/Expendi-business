import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StaffTreasury } from "@expendi-business/shared";
import { staffTreasurySchema } from "@expendi-business/shared";

import { quoteTransactions, TreasuryView } from "./treasury-view";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADDRESS = `0x${"ab".repeat(20)}`;
const BASE_TX = `0x${"cd".repeat(32)}`;
const NEAR_TX = "9ZkQ3dDmEoVvTyrJ4nH8";

const quote = (n: number, overrides: object = {}) => ({
  id: ID(n),
  purpose: "to_treasury" as const,
  status: "succeeded" as const,
  oneClickStatus: "SUCCESS" as const,
  amountIn: "50000000",
  amountOut: "49995000",
  swappedAmountOut: "49995000",
  refundedAmount: null,
  depositTxHash: NEAR_TX,
  nearTxHashes: [NEAR_TX],
  originChainTxHashes: [NEAR_TX],
  destinationChainTxHashes: [BASE_TX],
  failure: null,
  createdAt: "2026-11-10T09:00:00.000Z",
  settledAt: "2026-11-10T09:01:00.000Z",
  ...overrides,
});

const on = (overrides: object = {}): StaffTreasury =>
  staffTreasurySchema.parse({
    status: "on",
    address: ADDRESS,
    turnedOnAt: "2026-10-01T09:00:00.000Z",
    position: {
      state: "read",
      assetsInVault: "70000000",
      sharesInVault: "70000000",
      totalDeposited: "100000000",
      totalWithdrawn: "30000000",
      readAt: "2026-11-13T08:00:00.000Z",
    },
    alerts: [],
    moves: [
      {
        id: ID(1),
        direction: "to_treasury",
        status: "completed",
        isAll: false,
        requestedUsdc: "50000000",
        movedUsdc: "49995000",
        costUsdc: "5000",
        failure: null,
        createdAt: "2026-11-10T09:00:00.000Z",
        settledAt: "2026-11-10T09:02:00.000Z",
        quotes: [quote(11)],
        earnActions: [
          {
            id: ID(21),
            kind: "deposit",
            attempt: 1,
            referenceId: "tr-deposit-1",
            status: "succeeded",
            rawAmount: "49995000",
            deliveredUsdc: null,
            privyActionId: "privy-action-1",
            txHash: BASE_TX,
            intentQuoteId: ID(11),
            failure: null,
            createdAt: "2026-11-10T09:01:30.000Z",
            settledAt: "2026-11-10T09:02:00.000Z",
          },
        ],
        ledger: [
          {
            id: ID(31),
            type: "to_treasury",
            usdcAmount: "-50000000",
            chain: "near",
            txHash: NEAR_TX,
            intentQuoteId: ID(11),
            createdAt: "2026-11-10T09:00:30.000Z",
          },
        ],
        action: null,
      },
      {
        id: ID(2),
        direction: "to_wallet",
        status: "needs_review",
        isAll: true,
        requestedUsdc: "20000000",
        movedUsdc: null,
        costUsdc: null,
        failure: "Privy refused the transfer.",
        createdAt: "2026-11-12T09:00:00.000Z",
        settledAt: null,
        quotes: [
          quote(12, {
            purpose: "from_treasury",
            status: "failed",
            oneClickStatus: null,
            depositTxHash: null,
            nearTxHashes: [],
            originChainTxHashes: [],
            destinationChainTxHashes: [],
            swappedAmountOut: null,
            failure: "Privy refused it.",
            settledAt: "2026-11-12T09:01:00.000Z",
          }),
        ],
        earnActions: [
          {
            id: ID(22),
            kind: "withdraw",
            attempt: 1,
            referenceId: "tr-withdraw-1",
            status: "succeeded",
            rawAmount: "20000000",
            deliveredUsdc: "20000000",
            privyActionId: "privy-action-2",
            txHash: BASE_TX,
            intentQuoteId: null,
            failure: null,
            createdAt: "2026-11-12T09:00:10.000Z",
            settledAt: "2026-11-12T09:00:40.000Z",
          },
        ],
        ledger: [],
        action: { kind: "resume_return", amountUsdc: "20000000" },
      },
    ],
    ...overrides,
  });

const render = (
  treasury: StaffTreasury,
  actions = (id: string) => `[actions ${id}]`,
) =>
  renderToStaticMarkup(
    <TreasuryView
      treasury={treasury}
      renderActions={(move) => (move.action ? actions(move.id) : null)}
    />,
  );

describe("TreasuryView", () => {
  it("says Treasury is off for a company that hasn't turned it on", () => {
    // #when
    const html = render({ status: "off" });

    // #then
    expect(html).toContain("Treasury isn&#x27;t turned on for this company.");
  });

  it("shows the wallet with a Basescan link and the live position", () => {
    // #when
    const html = render(on());

    // #then
    expect(html).toContain(`href="https://basescan.org/address/${ADDRESS}"`);
    expect(html).toContain("70.000000 USDC");
    expect(html).toContain("100.000000 USDC");
    expect(html).toContain("30.000000 USDC");
    expect(html).not.toContain("Couldn&#x27;t read Privy");
  });

  it("says Privy couldn't be read, with its reason, and still lists the moves", () => {
    // #when
    const html = render(
      on({ position: { state: "unreadable", message: "Privy timed out" } }),
    );

    // #then
    expect(html).toContain("Couldn&#x27;t read Privy: Privy timed out");
    expect(html).toContain("Move to Treasury");
    expect(html).not.toContain("Value in the vault");
  });

  it("lists the open Treasury alerts, or says there are none", () => {
    // #when
    const quiet = render(on());
    const loud = render(
      on({
        alerts: [
          {
            id: ID(41),
            kind: "treasury_move_stuck",
            subjectKey: "move",
            organization: { id: ID(99), name: "Acme" },
            title: "A Treasury move isn't settled",
            details: [],
            occurrences: 1,
            openedAt: "2026-11-13T07:00:00.000Z",
            lastSeenAt: "2026-11-13T07:00:00.000Z",
            resolvedAt: null,
            email: {
              status: "sent",
              sentAt: null,
              attempts: 0,
              lastError: null,
              nextAttemptAt: null,
            },
          },
        ],
      }),
    );

    // #then
    expect(quiet).toContain("No open Treasury alerts.");
    expect(loud).toContain("A Treasury move isn&#x27;t settled");
    expect(loud).not.toContain("No open Treasury alerts.");
  });

  it("shows a move to Treasury's quote, Earn call and ledger row with their transactions", () => {
    // #when
    const html = render(on());

    // #then
    expect(html).toContain(`/intent-quotes/${ID(11)}`);
    expect(html).toContain("SUCCESS");
    expect(html).toContain(`https://nearblocks.io/txns/${NEAR_TX}`);
    expect(html).toContain(`https://basescan.org/tx/${BASE_TX}`);
    expect(html).toContain("tr-deposit-1");
    expect(html).toContain("privy-action-1");
    expect(html).toContain("-50.000000 USDC");
    expect(html).toContain("In the vault");
  });

  it("shows a move to the wallet's withdrawal delivery, its failed return and why it is under review", () => {
    // #when
    const html = render(on());

    // #then
    expect(html).toContain("Move to wallet");
    expect(html).toContain("needs review");
    expect(html).toContain("All of it, ");
    expect(html).toContain("tr-withdraw-1");
    expect(html).toContain("Privy refused the transfer.");
    expect(html).toContain("Privy refused it.");
    expect(html).toContain("Credited");
  });

  it("draws the staff action only on a move that offers one", () => {
    // #when
    const html = render(on());

    // #then
    expect(html).toContain(`[actions ${ID(2)}]`);
    expect(html).not.toContain(`[actions ${ID(1)}]`);
  });

  it("says when there are no moves yet", () => {
    // #then
    expect(render(on({ moves: [] }))).toContain("No moves yet.");
  });
});

describe("quoteTransactions", () => {
  it("lists the deposit first and each transaction once", () => {
    // #then
    expect(quoteTransactions(quote(11))).toEqual([NEAR_TX, BASE_TX]);
  });
});
