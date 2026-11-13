import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

import type {
  StaffTreasury,
  StaffTreasuryEarnAction,
  StaffTreasuryLedgerRow,
  StaffTreasuryMove,
  StaffTreasuryPosition,
  StaffTreasuryQuote,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type {
  IntentQuote,
  TreasuryEarnAction,
  TreasuryMove,
} from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { MoveRows } from "../treasury/return-eligibility.js";
import {
  intentQuotes,
  organizations,
  treasuryEarnActions,
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { TreasuryPositionReader } from "../treasury/position-reader.js";
import {
  assessResume,
  assessStranded,
} from "../treasury/return-eligibility.js";
import { listOpsAlerts } from "./alerts.js";
import { UUID } from "./paging.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * One company's Treasury for staff (docs/work/treasury/spec.md, "Expendi
 * team"): the Treasury wallet, Privy's position now, the open Treasury
 * alerts, and every move with the saved quotes, Earn calls and ledger rows
 * that show what happened to its USDC. The company's rows are read in its
 * scope in a read-only transaction; the position comes from Privy, and when
 * Privy can't be read the view says so rather than failing. Each quote links
 * on to the full evidence view, which asks 1Click and the chains.
 */

const noSuchCompany = new NotFound({ message: "No company with this ID" });

const iso = (date: Date): string => date.toISOString();

const treasuryQuoteView = (quote: IntentQuote): StaffTreasuryQuote => ({
  id: quote.id,
  purpose: quote.purpose === "from_treasury" ? "from_treasury" : "to_treasury",
  status: quote.status,
  oneClickStatus: quote.oneClickStatus,
  amountIn: quote.amountIn.toString(),
  amountOut: quote.amountOut.toString(),
  swappedAmountOut: quote.swappedAmountOut?.toString() ?? null,
  refundedAmount: quote.refundedAmount?.toString() ?? null,
  depositTxHash: quote.depositTxHash,
  nearTxHashes: quote.nearTxHashes,
  originChainTxHashes: quote.originChainTxHashes,
  destinationChainTxHashes: quote.destinationChainTxHashes,
  failure: quote.failure,
  createdAt: iso(quote.createdAt),
  settledAt: quote.settledAt ? iso(quote.settledAt) : null,
});

const earnActionView = (
  action: TreasuryEarnAction,
): StaffTreasuryEarnAction => ({
  id: action.id,
  kind: action.kind,
  attempt: action.attempt,
  referenceId: action.referenceId,
  status: action.status,
  rawAmount: action.rawAmount.toString(),
  deliveredUsdc: action.deliveredUsdc?.toString() ?? null,
  privyActionId: action.privyActionId,
  txHash: action.txHash,
  intentQuoteId: action.intentQuoteId,
  failure: action.failure,
  createdAt: iso(action.createdAt),
  settledAt: action.settledAt ? iso(action.settledAt) : null,
});

interface LedgerRecord {
  readonly id: string;
  readonly type: string;
  readonly usdcAmount: bigint;
  readonly chain: StaffTreasuryLedgerRow["chain"];
  readonly txHash: string | null;
  readonly intentQuoteId: string | null;
  readonly treasuryMoveId: string | null;
  readonly createdAt: Date;
}

const ledgerView = (row: LedgerRecord): StaffTreasuryLedgerRow => ({
  id: row.id,
  type: row.type === "from_treasury" ? "from_treasury" : "to_treasury",
  usdcAmount: row.usdcAmount.toString(),
  chain: row.chain,
  txHash: row.txHash,
  intentQuoteId: row.intentQuoteId,
  createdAt: iso(row.createdAt),
});

/** What staff may start on the move now, judged by the same rules the action applies. */
function availableAction(rows: MoveRows): StaffTreasuryMove["action"] {
  if (rows.move.status !== "needs_review") return null;
  const [kind, assessed] =
    rows.move.direction === "to_treasury"
      ? (["return_stranded_deposit", assessStranded(rows)] as const)
      : (["resume_return", assessResume(rows)] as const);
  return assessed.ok
    ? { kind, amountUsdc: assessed.amountUsdc.toString() }
    : null;
}

function moveView(
  move: TreasuryMove,
  quotes: readonly IntentQuote[],
  actions: readonly TreasuryEarnAction[],
  ledger: readonly LedgerRecord[],
): StaffTreasuryMove {
  const rows: MoveRows = {
    move,
    quotes: quotes.filter((quote) => quote.purpose === "to_treasury"),
    returns: quotes.filter((quote) => quote.purpose === "from_treasury"),
    actions,
  };
  return {
    id: move.id,
    direction: move.direction,
    status: move.status,
    isAll: move.isAll,
    requestedUsdc: move.requestedUsdc.toString(),
    movedUsdc: move.movedUsdc?.toString() ?? null,
    costUsdc: move.costUsdc?.toString() ?? null,
    failure: move.failure,
    createdAt: iso(move.createdAt),
    settledAt: move.settledAt ? iso(move.settledAt) : null,
    quotes: quotes.map(treasuryQuoteView),
    earnActions: actions.map(earnActionView),
    ledger: ledger.map(ledgerView),
    action: availableAction(rows),
  };
}

export function staffTreasury(
  organizationId: string,
): Effect.Effect<
  StaffTreasury,
  NotFound | DatabaseError,
  DatabaseService | TreasuryPositionReader
> {
  if (!UUID.test(organizationId)) return Effect.fail(noSuchCompany);
  return Effect.gen(function* () {
    const read = yield* withStaffReadScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [company] = yield* query(() =>
          tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, organizationId)),
        );
        if (!company) return null;
        const [wallet] = yield* query(() =>
          tx
            .select()
            .from(wallets)
            .where(eq(wallets.organizationId, organizationId)),
        );
        if (
          !wallet?.treasuryTurnedOnAt ||
          !wallet.treasuryAddress ||
          !wallet.treasuryPrivyWalletId
        ) {
          return { wallet: null } as const;
        }
        const moves = yield* query(() =>
          tx
            .select()
            .from(treasuryMoves)
            .where(eq(treasuryMoves.organizationId, organizationId))
            .orderBy(desc(treasuryMoves.createdAt), desc(treasuryMoves.id)),
        );
        const quotes = yield* query(() =>
          tx
            .select()
            .from(intentQuotes)
            .where(
              and(
                eq(intentQuotes.organizationId, organizationId),
                isNotNull(intentQuotes.treasuryMoveId),
              ),
            )
            .orderBy(intentQuotes.createdAt, intentQuotes.id),
        );
        const actions = yield* query(() =>
          tx
            .select()
            .from(treasuryEarnActions)
            .where(eq(treasuryEarnActions.organizationId, organizationId))
            .orderBy(
              treasuryEarnActions.createdAt,
              treasuryEarnActions.attempt,
            ),
        );
        const ledger = yield* query(() =>
          tx
            .select({
              id: walletTransactions.id,
              type: walletTransactions.type,
              usdcAmount: walletTransactions.usdcAmount,
              chain: walletTransactions.chain,
              txHash: walletTransactions.txHash,
              intentQuoteId: walletTransactions.intentQuoteId,
              treasuryMoveId: walletTransactions.treasuryMoveId,
              createdAt: walletTransactions.createdAt,
            })
            .from(walletTransactions)
            .where(
              and(
                eq(walletTransactions.organizationId, organizationId),
                inArray(walletTransactions.type, [
                  "to_treasury",
                  "from_treasury",
                ]),
              ),
            )
            .orderBy(walletTransactions.createdAt, walletTransactions.id),
        );
        return { wallet, moves, quotes, actions, ledger } as const;
      }),
    );
    if (read === null) return yield* Effect.fail(noSuchCompany);
    if (read.wallet === null) return { status: "off" } as const;
    const { wallet } = read;
    const { treasuryAddress, treasuryPrivyWalletId, treasuryTurnedOnAt } =
      wallet;
    if (!treasuryAddress || !treasuryPrivyWalletId || !treasuryTurnedOnAt) {
      return { status: "off" } as const;
    }

    const reader = yield* TreasuryPositionReader;
    const position: StaffTreasuryPosition = yield* reader
      .read(treasuryPrivyWalletId)
      .pipe(
        Effect.map((live): StaffTreasuryPosition => ({
          state: "read",
          assetsInVault: live.assetsInVault.toString(),
          sharesInVault: live.sharesInVault.toString(),
          totalDeposited: live.totalDeposited.toString(),
          totalWithdrawn: live.totalWithdrawn.toString(),
          readAt: new Date().toISOString(),
        })),
        Effect.catchTag("PositionUnavailable", (error) =>
          Effect.succeed<StaffTreasuryPosition>({
            state: "unreadable",
            message: error.message,
          }),
        ),
      );

    const { open } = yield* listOpsAlerts();
    return {
      status: "on",
      address: treasuryAddress,
      turnedOnAt: iso(treasuryTurnedOnAt),
      position,
      alerts: open.filter(
        (alert) =>
          alert.organization?.id === organizationId &&
          alert.kind.startsWith("treasury_"),
      ),
      moves: read.moves.map((move) =>
        moveView(
          move,
          read.quotes.filter((quote) => quote.treasuryMoveId === move.id),
          read.actions.filter((action) => action.treasuryMoveId === move.id),
          read.ledger.filter((row) => row.treasuryMoveId === move.id),
        ),
      ),
    };
  });
}
