import type {
  TreasuryMoveList,
  TreasuryMovePreview,
  TreasuryMoveSummary,
  TreasuryStatus,
} from "@expendi-business/shared";

import type { StrandedReturn } from "../../src/services/treasury/stranded.js";
import type {
  MoveInspection,
  OpenAlert,
  QaBanner,
  Reconciliation,
} from "./treasury-qa-commands.js";
import { formatUsdc } from "./treasury-qa-commands.js";

/** The text each command prints; the data itself comes from `treasury-qa-commands.ts`. */

const usdc = (units: string | bigint | null): string =>
  units === null ? "-" : `${formatUsdc(BigInt(units))} USDC`;

const nearblocks = (hash: string) => `https://nearblocks.io/txns/${hash}`;
const basescan = (hash: string) => `https://basescan.org/tx/${hash}`;

export const formatBanner = (banner: QaBanner): string[] => [
  `Company:  ${banner.companyName}`,
  `Database: ${banner.databaseHost}`,
  "",
];

export function formatStatus(status: TreasuryStatus): string[] {
  if (status.status !== "on") return [`Treasury: ${status.status}`];
  return [
    "Treasury: on",
    `Address:   ${status.address}`,
    `Value:     ${usdc(status.valueUsdc)}`,
    `Yield:     ${usdc(status.yieldUsdc)}`,
    `Rate:      ${status.rateBps === null ? "-" : `${(status.rateBps / 100).toFixed(2)}%`}`,
    `KES:       ${status.kesEquivalent ? `${(BigInt(status.kesEquivalent.kesCents) / 100n).toString()} (rate ${status.kesEquivalent.rate})` : "-"}`,
    `Open move: ${status.openMove ? `${status.openMove.id} ${status.openMove.direction} ${usdc(status.openMove.amountUsdc)}, ${status.openMove.statusText}` : "none"}`,
    `As of:     ${status.asOf ?? "-"}${status.saved ? " (saved figures: Privy couldn't be read)" : ""}`,
  ];
}

export function formatPreview(preview: TreasuryMovePreview): string[] {
  return [
    `Direction:      ${preview.direction}${preview.isAll ? " (all)" : ""}`,
    `Amount:         ${usdc(preview.amountUsdc)}`,
    `Parts:          ${preview.parts} (at most ${usdc(preview.perPartMaxUsdc)} each)`,
    `Estimated cost: ${usdc(preview.estimatedCostUsdc)}`,
    `Estimated time: ${preview.estimatedSeconds} seconds`,
    `Available:      ${usdc(preview.availableUsdc)}`,
    ...(preview.inTreasuryUsdc === undefined
      ? []
      : [`In Treasury:    ${usdc(preview.inTreasuryUsdc)}`]),
  ];
}

const moveLine = (move: TreasuryMoveSummary): string =>
  [
    move.id,
    move.createdAt,
    move.direction,
    move.status,
    `asked ${usdc(move.requestedUsdc)}${move.isAll ? " (all)" : ""}`,
    `moved ${usdc(move.movedUsdc)}`,
    `cost ${usdc(move.costUsdc)}`,
    ...(move.failure ? [`failure: ${move.failure}`] : []),
  ].join("  ");

export const formatStartedMove = (move: TreasuryMoveSummary): string[] => [
  `Started move ${move.id}`,
  moveLine(move),
  `Follow it with: inspect --move-id ${move.id}`,
];

export const formatMoves = (list: TreasuryMoveList): string[] =>
  list.moves.length === 0 ? ["No moves yet"] : list.moves.map(moveLine);

export function formatInspection(inspection: MoveInspection): string[] {
  const { move } = inspection;
  const lines = [
    "Move",
    `  ${moveLine(move)}`,
    `  settled: ${move.settledAt ?? "not yet"}`,
    "",
    `Quotes (${inspection.quotes.length})`,
  ];
  for (const quote of inspection.quotes) {
    lines.push(
      `  ${quote.id}  ${quote.purpose}  ${quote.status}  in ${usdc(quote.amountIn)}  out ${usdc(quote.amountOut)}  delivered ${usdc(quote.swappedAmountOut)}`,
      `    deposit address: ${quote.depositAddress}`,
      `    1Click: ${quote.oneClickStatus ?? "-"}${quote.failure ? `  failure: ${quote.failure}` : ""}`,
      ...quote.nearTxHashes.map((hash) => `    NEAR ${nearblocks(hash)}`),
      ...quote.baseTxHashes.map((hash) => `    Base ${basescan(hash)}`),
    );
  }
  lines.push("", `Earn actions (${inspection.earnActions.length})`);
  for (const action of inspection.earnActions) {
    lines.push(
      `  ${action.kind}  attempt ${action.attempt}  ${action.status}  ${usdc(action.rawAmount)}  delivered ${usdc(action.deliveredUsdc)}`,
      `    reference: ${action.referenceId}  Privy action: ${action.privyActionId ?? "-"}`,
      ...(action.txHash ? [`    Base ${basescan(action.txHash)}`] : []),
      ...(action.failure ? [`    failure: ${action.failure}`] : []),
    );
  }
  lines.push("", `Ledger rows (${inspection.ledger.length})`);
  for (const row of inspection.ledger) {
    lines.push(
      `  ${row.createdAt.toISOString()}  ${row.type}  ${usdc(row.usdcAmount)}${row.txHash ? `  ${row.txHash}` : ""}`,
    );
  }
  lines.push("", "Vault position (live)");
  if (inspection.vault) {
    lines.push(
      `  worth ${usdc(inspection.vault.assetsInVault)}  shares ${inspection.vault.sharesInVault}`,
      `  Privy's totals: deposited ${usdc(inspection.vault.totalDeposited)}, withdrawn ${usdc(inspection.vault.totalWithdrawn)}`,
    );
  } else {
    lines.push(`  ${inspection.vaultNote ?? "unavailable"}`);
  }
  return lines;
}

export function formatReconciliation(result: Reconciliation): string[] {
  const lines = [
    `Ledger balance:            ${usdc(result.ledgerUsdc)}`,
    `Company wallet (NEAR):     ${usdc(result.nearUsdc)}`,
    `Transit wallet (Base):     ${usdc(result.baseUsdc)}`,
    ...(result.balanceHome === "confidential_account"
      ? [`Confidential account:      ${usdc(result.confidentialUsdc)}`]
      : []),
    `Difference (chain less ledger): ${usdc(result.differenceUsdc)}`,
    `Expendi's recorded surplus:     ${usdc(result.expendiSurplusUsdc)}`,
    ...(result.balanceHome === "confidential_account"
      ? [
          `  of which in the company wallet: ${usdc(result.companyWalletSurplusUsdc)}`,
        ]
      : []),
  ];
  if (result.differenceUsdc === 0n) lines.push("The ledger matches the chain.");
  for (const error of result.errors) lines.push(`Warning: ${error}`);
  if (result.overdueCredits.length > 0) {
    lines.push(
      `Warning: 1Click reports these quotes delivered to the confidential account, but the ledger doesn't hold them: ${result.overdueCredits.join(", ")}`,
    );
  }
  if (result.inFlight.length > 0) {
    lines.push(
      "Warning: money is in flight, so the numbers can legitimately differ now:",
      ...result.inFlight.map((reason) => `  - ${reason}`),
    );
  }
  return lines;
}

export function formatAlerts(open: readonly OpenAlert[]): string[] {
  if (open.length === 0) return ["No open Treasury alerts"];
  return open.flatMap((alert) => [
    `${alert.kind}  ${alert.title}  (opened ${alert.openedAt.toISOString()}, seen ${alert.occurrences}x)`,
    ...alert.details.map((detail) => `    ${detail.label}: ${detail.value}`),
  ]);
}

export const formatStranded = (result: StrandedReturn): string[] => [
  `Sending ${usdc(result.amountUsdc)} of move ${result.moveId} back from the Treasury wallet.`,
  `Return quote: ${result.quoteId}. The station job carries it on; follow it with: inspect --move-id ${result.moveId}`,
];

export const formatEnrolment = (result: {
  readonly email: string;
  readonly userId: string;
}): string[] => [
  `Enrolled a software approval passkey for ${result.email} (user ${result.userId}).`,
];
