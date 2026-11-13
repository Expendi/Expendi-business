import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type {
  TreasuryMovePreview,
  TreasuryMoveRequest,
  TreasuryMoveSummary,
  TreasuryOffer,
  TreasuryOpenMove,
  TreasuryProgress,
  TreasuryProgressStep,
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
  | "unavailable"
  | "off"
  | "on"
  | "move"
  | "move-way"
  | "move-arriving"
  | "move-split"
  | "move-review"
  | "move-out"
  | "move-back"
  | "saved"
  | "short"
  | "history";

type StepKey = TreasuryProgressStep["key"];

export const IN_STEPS: readonly StepKey[] = [
  "leaving_wallet",
  "on_its_way",
  "arriving",
  "in_treasury",
];
export const OUT_STEPS: readonly StepKey[] = [
  "leaving_treasury",
  "on_its_way",
  "in_wallet",
];

const MINUTE_MS = 60_000;

/**
 * A move's steps with the one at `at` current (or failed, when the move
 * stopped there): the ones before it are done, two minutes apart from `from`.
 */
export function progressAt(
  keys: readonly StepKey[],
  at: number,
  options: {
    readonly from?: string;
    readonly stopped?: boolean;
    readonly part?: number;
    readonly parts?: number;
    readonly finished?: boolean;
  } = {},
): TreasuryProgress {
  const from = Date.parse(options.from ?? "2026-11-06T06:21:00.000Z");
  const finished = options.finished ?? false;
  return {
    steps: keys.map((key, index) => {
      const done = finished || index < at;
      const state: TreasuryProgressStep["state"] = done
        ? "done"
        : index > at
          ? "waiting"
          : options.stopped
            ? "failed"
            : "current";
      return {
        key,
        state,
        at: done
          ? new Date(from + (index + 1) * 2 * MINUTE_MS).toISOString()
          : null,
      };
    }),
    ...(options.part !== undefined && { part: options.part }),
    ...(options.parts !== undefined && { parts: options.parts }),
  };
}

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

const OPEN_IN: TreasuryOpenMove = {
  id: sampleId(951),
  direction: "to_treasury",
  amountUsdc: "1000000000",
  isAll: false,
  status: "open",
  statusText: "On its way to Treasury",
  startedAt: "2026-11-06T06:21:00.000Z",
  progress: progressAt(IN_STEPS, 0),
};

const OPEN_OUT: TreasuryOpenMove = {
  ...OPEN_IN,
  direction: "to_wallet",
  statusText: "On its way to your wallet",
  progress: progressAt(OUT_STEPS, 0),
};

/** Each state a move in flight can be in, for the card's callout and the sheet. */
export const OPEN_MOVES: Record<
  Extract<TreasuryScenario, `move${string}`>,
  TreasuryOpenMove
> = {
  move: OPEN_IN,
  "move-way": { ...OPEN_IN, progress: progressAt(IN_STEPS, 1) },
  "move-arriving": { ...OPEN_IN, progress: progressAt(IN_STEPS, 2) },
  "move-split": {
    ...OPEN_IN,
    amountUsdc: "70000000000",
    progress: progressAt(IN_STEPS, 1, { part: 2, parts: 3 }),
  },
  "move-review": {
    ...OPEN_IN,
    status: "needs_review",
    statusText: "Being checked by Expendi",
    progress: progressAt(IN_STEPS, 2, { stopped: true }),
  },
  "move-out": OPEN_OUT,
  "move-back": { ...OPEN_OUT, progress: progressAt(OUT_STEPS, 1) },
};

export const TREASURY_STATUSES: Record<
  Exclude<TreasuryScenario, "short">,
  TreasuryStatus
> = {
  unavailable: { status: "unavailable" },
  off: { status: "off", rateBps: 519 },
  on: ON,
  move: { ...ON, openMove: OPEN_MOVES.move },
  "move-way": { ...ON, openMove: OPEN_MOVES["move-way"] },
  "move-arriving": { ...ON, openMove: OPEN_MOVES["move-arriving"] },
  "move-split": { ...ON, openMove: OPEN_MOVES["move-split"] },
  "move-review": { ...ON, openMove: OPEN_MOVES["move-review"] },
  "move-out": { ...ON, openMove: OPEN_MOVES["move-out"] },
  "move-back": { ...ON, openMove: OPEN_MOVES["move-back"] },
  saved: {
    ...ON,
    asOf: "2026-11-05T21:00:11.000Z",
    saved: true,
  },
  history: ON,
};

/** The history's row for a move in flight. */
export const openMoveSummary = (
  open: TreasuryOpenMove,
): TreasuryMoveSummary => ({
  id: open.id,
  direction: open.direction,
  status: open.status,
  requestedUsdc: open.amountUsdc,
  isAll: open.isAll,
  movedUsdc: null,
  costUsdc: null,
  deliveredUsdc: null,
  failure: null,
  createdAt: open.startedAt,
  settledAt: null,
  ...(open.progress && { progress: open.progress }),
});

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
    progress: progressAt(OUT_STEPS, 0, {
      from: "2026-11-02T07:10:00.000Z",
      finished: true,
    }),
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
    progress: progressAt(IN_STEPS, 1, {
      from: "2026-10-28T11:42:00.000Z",
      stopped: true,
    }),
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
    progress: progressAt(IN_STEPS, 0, {
      from: "2026-10-20T08:05:00.000Z",
      finished: true,
    }),
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
    progress: progressAt(OUT_STEPS, 0, {
      from: "2026-09-15T09:30:00.000Z",
      finished: true,
    }),
  },
];

const OLDER_MOVES_ASKED = [
  "1840000000",
  "730500000",
  "2600000000",
  "415250000",
  "3100000000",
  "960000000",
  "1275800000",
  "500000000",
] as const;

/** Eight earlier moves, a week apart, so the history runs to three pages. */
export const OLDER_TREASURY_MOVES: TreasuryMoveSummary[] =
  OLDER_MOVES_ASKED.map((requestedUsdc, index) => {
    const toWallet = index % 3 === 1;
    const costUsdc = String(380000 + index * 30000);
    const createdAt = new Date(
      Date.parse("2026-09-08T08:40:00.000Z") - index * 7 * 24 * 60 * MINUTE_MS,
    ).toISOString();
    return {
      id: sampleId(960 + index),
      direction: toWallet ? "to_wallet" : "to_treasury",
      status: "completed",
      requestedUsdc,
      isAll: false,
      movedUsdc: String(BigInt(requestedUsdc) - BigInt(costUsdc)),
      costUsdc,
      deliveredUsdc: toWallet ? requestedUsdc : null,
      failure: null,
      createdAt,
      settledAt: new Date(Date.parse(createdAt) + 6 * MINUTE_MS).toISOString(),
      progress: progressAt(toWallet ? OUT_STEPS : IN_STEPS, 0, {
        from: createdAt,
        finished: true,
      }),
    };
  });

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
      ...(status.openMove ? [openMoveSummary(status.openMove)] : []),
      ...TREASURY_MOVES,
      ...(scenario === "history" ? OLDER_TREASURY_MOVES : []),
    ]);
    client.setQueryData(walletKeys.history(org), withTreasuryRows());
  }
}
