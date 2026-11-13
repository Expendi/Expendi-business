import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type {
  TreasuryMovePreview,
  TreasuryMoveRequest,
  TreasuryMoveSummary,
  TreasuryOffer,
  TreasuryStatus,
  WalletHistoryItem,
  WalletHistoryResponse,
} from "@expendi-business/shared";

import { treasuryKeys } from "~/app/(company)/wallet/_components/treasury-api";
import { walletKeys } from "~/app/(company)/wallet/_components/wallet-api";
import { ApiError } from "~/lib/api";
import { KES_RATE, ORGANIZATION_ID, sampleId } from "./company";
import { LEDGER } from "./wallet";

/**
 * Treasury as Mwangaza Logistics sees it on 6 Nov 2026, in each state the
 * Accounts page can show. `/dev/preview/treasury-<scenario>` opens one.
 */
export type TreasuryScenario =
  "unavailable" | "off" | "on" | "move" | "saved" | "short";

const ON: Extract<TreasuryStatus, { status: "on" }> = {
  status: "on",
  address: "0x4b2e7a9c1d3f58606e2a9b7c1d4f8a3e5c0b9d72",
  valueUsdc: "4215370000",
  yieldUsdc: "15370000",
  rateBps: 519,
  kesEquivalent: { kesCents: "54378273", rate: KES_RATE },
  openMove: null,
  asOf: "2026-11-06T06:29:40.000Z",
  saved: false,
};

export const TREASURY_STATUSES: Record<
  Exclude<TreasuryScenario, "short">,
  TreasuryStatus
> = {
  unavailable: { status: "unavailable" },
  off: { status: "off", rateBps: 519 },
  on: ON,
  move: {
    ...ON,
    openMove: {
      id: sampleId(951),
      direction: "to_treasury",
      amountUsdc: "1000000000",
      isAll: false,
      status: "open",
      statusText: "On its way to Treasury",
      startedAt: "2026-11-06T06:21:00.000Z",
    },
  },
  saved: {
    ...ON,
    asOf: "2026-11-05T21:00:11.000Z",
    saved: true,
  },
};

const OPEN_MOVE: TreasuryMoveSummary = {
  id: sampleId(951),
  direction: "to_treasury",
  status: "open",
  requestedUsdc: "1000000000",
  isAll: false,
  movedUsdc: null,
  costUsdc: null,
  deliveredUsdc: null,
  failure: null,
  createdAt: "2026-11-06T06:21:00.000Z",
  settledAt: null,
};

export const TREASURY_MOVES: TreasuryMoveSummary[] = [
  {
    id: sampleId(952),
    direction: "to_wallet",
    status: "completed",
    requestedUsdc: "1000000000",
    isAll: false,
    movedUsdc: "999540000",
    costUsdc: "460000",
    deliveredUsdc: "1000000000",
    failure: null,
    createdAt: "2026-11-02T07:10:00.000Z",
    settledAt: "2026-11-02T07:16:00.000Z",
  },
  {
    id: sampleId(953),
    direction: "to_treasury",
    status: "returned",
    requestedUsdc: "500000000",
    isAll: false,
    movedUsdc: "0",
    costUsdc: "310000",
    deliveredUsdc: null,
    failure: null,
    createdAt: "2026-10-28T11:42:00.000Z",
    settledAt: "2026-10-28T11:55:00.000Z",
  },
  {
    id: sampleId(954),
    direction: "to_treasury",
    status: "completed",
    requestedUsdc: "5200000000",
    isAll: false,
    movedUsdc: "5199380000",
    costUsdc: "620000",
    deliveredUsdc: null,
    failure: null,
    createdAt: "2026-10-20T08:05:00.000Z",
    settledAt: "2026-10-20T08:12:00.000Z",
  },
  {
    id: sampleId(955),
    direction: "to_wallet",
    status: "completed",
    requestedUsdc: "250120000",
    isAll: true,
    movedUsdc: "249690000",
    costUsdc: "430000",
    deliveredUsdc: "250120000",
    failure: null,
    createdAt: "2026-09-15T09:30:00.000Z",
    settledAt: "2026-09-15T09:36:00.000Z",
  },
];

/** Moves to and from Treasury as the wallet history lists them. */
const TREASURY_LEDGER_ROWS: WalletHistoryItem[] = [
  {
    id: sampleId(956),
    type: "from_treasury",
    usdcAmount: "999540000",
    chain: "near",
    txHash: null,
    counterpartyAddress: null,
    createdAt: "2026-11-02T07:16:00.000Z",
    payout: null,
  },
  {
    id: sampleId(957),
    type: "to_treasury",
    usdcAmount: "-5200000000",
    chain: "near",
    txHash: null,
    counterpartyAddress: null,
    createdAt: "2026-10-20T08:05:00.000Z",
    payout: null,
  },
];

/** A payment the wallet was too short for while Treasury held money, as the API refuses it. */
export const SHORT_WALLET_OFFER: TreasuryOffer = {
  action: "move_to_wallet",
  shortfallUsdc: "412650000",
  inTreasuryUsdc: "4215370000",
  suggestedUsdc: "412650000",
};

export const SHORT_WALLET_REFUSAL = new ApiError(
  409,
  "Conflict",
  "The wallet is short by 412.65 USDC and Treasury holds 4,215.37 USDC. Use Move to wallet, then approve again. Nothing was sent.",
  {
    shortfallUsdc: "412650000",
    topUpKes: "5323185",
    treasuryOffer: SHORT_WALLET_OFFER,
  },
);

/** What the API's dry run would answer, so the move sheet has a preview to show. */
export function previewFor(request: TreasuryMoveRequest): TreasuryMovePreview {
  const all = request.amountUsdc === "all";
  return {
    direction: request.direction,
    amountUsdc: all ? "4215370000" : request.amountUsdc,
    ...(all && { isAll: true }),
    parts: 1,
    perPartMaxUsdc: "20000000000",
    estimatedCostUsdc: "460000",
    estimatedSeconds: 240,
    availableUsdc: "16420800000",
    ...(request.direction === "to_wallet" && {
      inTreasuryUsdc: "4215370000",
    }),
  };
}

function withTreasuryRows(): InfiniteData<WalletHistoryResponse> {
  const history = LEDGER.slice(0, 9);
  const items = [...TREASURY_LEDGER_ROWS, ...history].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return {
    pages: [{ items, nextCursor: history.at(-1)?.id ?? null }],
    pageParams: [null],
  };
}

export function seedTreasury(
  client: QueryClient,
  scenario: TreasuryScenario,
): void {
  const org = ORGANIZATION_ID;
  const key = scenario === "short" ? "on" : scenario;
  const status = TREASURY_STATUSES[key];
  client.setQueryData(treasuryKeys.status(org), status);
  if (status.status === "on") {
    client.setQueryData(treasuryKeys.moves(org), [
      ...(status.openMove ? [OPEN_MOVE] : []),
      ...TREASURY_MOVES,
    ]);
    client.setQueryData(walletKeys.history(org), withTreasuryRows());
  }
}
