import type { ReactNode } from "react";
import Link from "next/link";

import type {
  StaffTreasury,
  StaffTreasuryMove,
  StaffTreasuryQuote,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { StatusBadge } from "~/components/data/status-badge";
import {
  INTENT_QUOTE_PURPOSE_LABELS,
  IntentQuoteStatusBadge,
} from "~/components/intent-quote-status";
import { PageEmpty } from "~/components/page-state";
import { linkClass } from "~/components/styles";
import { basescanAddressUrl, transactionUrl } from "~/lib/explorer";
import { formatNairobiTime, formatUsdc } from "~/lib/format";

type TreasuryOn = Extract<StaffTreasury, { status: "on" }>;

const DIRECTION_LABELS = {
  to_treasury: "Move to Treasury",
  to_wallet: "Move to wallet",
} as const;

const MOVE_TONES: Record<StaffTreasuryMove["status"], StatusTone> = {
  open: "moving",
  completed: "paid",
  returned: "quiet",
  failed: "failed",
  needs_review: "waiting",
};

function Hash({ hash }: { hash: string }) {
  return (
    <a
      href={transactionUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className={`${linkClass} font-mono text-xs break-all`}
    >
      {hash}
    </a>
  );
}

function Hashes({ hashes }: { hashes: readonly string[] }) {
  if (hashes.length === 0) return <>—</>;
  return (
    <>
      {hashes.map((hash) => (
        <span key={hash} className="block">
          <Hash hash={hash} />
        </span>
      ))}
    </>
  );
}

/** Every transaction a quote lists, the deposit first and each once. */
export function quoteTransactions(quote: StaffTreasuryQuote): string[] {
  return [
    ...new Set(
      [
        quote.depositTxHash,
        ...quote.originChainTxHashes,
        ...quote.nearTxHashes,
        ...quote.destinationChainTxHashes,
      ].flatMap((hash) => (hash === null ? [] : [hash])),
    ),
  ];
}

function Evidence({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium">{title}</h4>
      {empty === null ? (
        <div className="mt-2 overflow-x-auto">{children}</div>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

const headCell = "px-3 py-2 text-xs font-medium text-muted-foreground";
const cell = "px-3 py-2 align-top";

function Quotes({ quotes }: { quotes: readonly StaffTreasuryQuote[] }) {
  return (
    <Evidence
      title="Intent quotes"
      empty={quotes.length === 0 ? "No quotes were taken." : null}
    >
      <table className="w-full text-left text-sm" aria-label="Intent quotes">
        <thead>
          <tr>
            {[
              "Quote",
              "Status",
              "1Click",
              "Sent",
              "Delivered",
              "Refunded",
              "Transactions",
            ].map((title) => (
              <th key={title} scope="col" className={headCell}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {quotes.map((quote) => (
            <tr key={quote.id} className="border-t">
              <td className={cell}>
                <Link href={`/intent-quotes/${quote.id}`} className={linkClass}>
                  {INTENT_QUOTE_PURPOSE_LABELS[quote.purpose]}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {formatNairobiTime(quote.createdAt)}
                </span>
              </td>
              <td className={cell}>
                <IntentQuoteStatusBadge status={quote.status} />
                {quote.failure ? (
                  <span className="mt-1 block text-xs">{quote.failure}</span>
                ) : null}
              </td>
              <td className={cell}>{quote.oneClickStatus ?? "—"}</td>
              <td className={cell}>{formatUsdc(quote.amountIn)}</td>
              <td className={cell}>
                {quote.swappedAmountOut
                  ? formatUsdc(quote.swappedAmountOut)
                  : `${formatUsdc(quote.amountOut)} quoted`}
              </td>
              <td className={cell}>
                {quote.refundedAmount ? formatUsdc(quote.refundedAmount) : "—"}
              </td>
              <td className={cell}>
                <Hashes hashes={quoteTransactions(quote)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Evidence>
  );
}

function EarnActions({ move }: { move: StaffTreasuryMove }) {
  const { earnActions } = move;
  return (
    <Evidence
      title="Earn actions"
      empty={earnActions.length === 0 ? "No Earn call was made." : null}
    >
      <table className="w-full text-left text-sm" aria-label="Earn actions">
        <thead>
          <tr>
            {[
              "Kind",
              "Attempt",
              "Reference",
              "Status",
              "Amount",
              "Delivered",
              "Privy action",
              "Transaction",
            ].map((title) => (
              <th key={title} scope="col" className={headCell}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {earnActions.map((action) => (
            <tr key={action.id} className="border-t">
              <td className={cell}>{action.kind}</td>
              <td className={cell}>{action.attempt}</td>
              <td className={`${cell} font-mono text-xs break-all`}>
                {action.referenceId}
              </td>
              <td className={cell}>
                {action.status}
                {action.failure ? (
                  <span className="block text-xs">{action.failure}</span>
                ) : null}
              </td>
              <td className={cell}>{formatUsdc(action.rawAmount)}</td>
              <td className={cell}>
                {action.deliveredUsdc ? formatUsdc(action.deliveredUsdc) : "—"}
              </td>
              <td className={`${cell} font-mono text-xs break-all`}>
                {action.privyActionId ?? "—"}
              </td>
              <td className={cell}>
                <Hashes hashes={action.txHash ? [action.txHash] : []} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Evidence>
  );
}

function LedgerRows({ move }: { move: StaffTreasuryMove }) {
  const { ledger } = move;
  return (
    <Evidence
      title="Ledger rows"
      empty={ledger.length === 0 ? "Nothing was written to the ledger." : null}
    >
      <table className="w-full text-left text-sm" aria-label="Ledger rows">
        <thead>
          <tr>
            {["Time", "Type", "Amount", "Transaction"].map((title) => (
              <th key={title} scope="col" className={headCell}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ledger.map((row) => (
            <tr key={row.id} className="border-t">
              <td className={cell}>{formatNairobiTime(row.createdAt)}</td>
              <td className={cell}>{row.type}</td>
              <td className={cell}>{formatUsdc(row.usdcAmount)}</td>
              <td className={cell}>
                <Hashes hashes={row.txHash ? [row.txHash] : []} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Evidence>
  );
}

function Move({
  move,
  actions,
}: {
  move: StaffTreasuryMove;
  actions: ReactNode;
}) {
  return (
    <article
      aria-label={`${DIRECTION_LABELS[move.direction]} ${move.id}`}
      className="border-t px-4 py-4 sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">
          {DIRECTION_LABELS[move.direction]}
        </h3>
        <StatusBadge tone={MOVE_TONES[move.status]}>
          {move.status.replace("_", " ")}
        </StatusBadge>
        <span className="text-xs text-muted-foreground">
          {formatNairobiTime(move.createdAt)}
        </span>
      </div>
      <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
        {move.id}
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Asked</dt>
        <dd>
          {move.isAll ? "All of it, " : ""}
          {formatUsdc(move.requestedUsdc)}
        </dd>
        <dt className="text-muted-foreground">
          {move.direction === "to_treasury" ? "In the vault" : "Credited"}
        </dt>
        <dd>{move.movedUsdc ? formatUsdc(move.movedUsdc) : "Not settled"}</dd>
        <dt className="text-muted-foreground">Cost</dt>
        <dd>{move.costUsdc ? formatUsdc(move.costUsdc) : "Not settled"}</dd>
        {move.failure ? (
          <>
            <dt className="text-muted-foreground">Why</dt>
            <dd className="wrap-anywhere">{move.failure}</dd>
          </>
        ) : null}
      </dl>
      <Quotes quotes={move.quotes} />
      <EarnActions move={move} />
      <LedgerRows move={move} />
      {actions}
    </article>
  );
}

function Position({ position }: { position: TreasuryOn["position"] }) {
  if (position.state === "unreadable") {
    return (
      <div role="alert" className="text-sm">
        Couldn&apos;t read Privy: {position.message}. The moves below are from
        Expendi&apos;s own records.
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">Value in the vault</dt>
      <dd>{formatUsdc(position.assetsInVault)}</dd>
      <dt className="text-muted-foreground">Total deposited</dt>
      <dd>{formatUsdc(position.totalDeposited)}</dd>
      <dt className="text-muted-foreground">Total withdrawn</dt>
      <dd>{formatUsdc(position.totalWithdrawn)}</dd>
      <dt className="text-muted-foreground">Read from Privy</dt>
      <dd>{formatNairobiTime(position.readAt)}</dd>
    </dl>
  );
}

/**
 * A company's Treasury (spec §6.15): its wallet, Privy's position now, its
 * open Treasury alerts and every move with the quotes, Earn calls and ledger
 * rows that show what happened to its USDC. Staff actions on a move under
 * review are drawn by `renderActions`, so this stays a plain view.
 */
export function TreasuryView({
  treasury,
  renderActions,
}: {
  treasury: StaffTreasury;
  renderActions: (move: StaffTreasuryMove) => ReactNode;
}) {
  if (treasury.status === "off") {
    return <PageEmpty title="Treasury isn't turned on for this company." />;
  }
  return (
    <div>
      <div className="space-y-4 px-4 py-4 sm:px-6">
        <p className="text-sm">
          <span className="text-muted-foreground">
            Treasury wallet on Base{" "}
          </span>
          <a
            href={basescanAddressUrl(treasury.address)}
            target="_blank"
            rel="noreferrer"
            className={`${linkClass} font-mono text-xs break-all`}
          >
            {treasury.address}
          </a>
          <span className="block text-xs text-muted-foreground">
            Turned on {formatNairobiTime(treasury.turnedOnAt)}
          </span>
        </p>
        <Position position={treasury.position} />
        <div>
          <h3 className="text-sm font-medium">Open alerts</h3>
          {treasury.alerts.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              No open Treasury alerts.
            </p>
          ) : (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {treasury.alerts.map((alert) => (
                <li key={alert.id}>
                  <Link href="/alerts" className={linkClass}>
                    {alert.title}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">
                    open since {formatNairobiTime(alert.openedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {treasury.moves.length === 0 ? (
        <p className="border-t px-4 py-4 text-sm text-muted-foreground sm:px-6">
          No moves yet.
        </p>
      ) : (
        treasury.moves.map((move) => (
          <Move key={move.id} move={move} actions={renderActions(move)} />
        ))
      )}
    </div>
  );
}
