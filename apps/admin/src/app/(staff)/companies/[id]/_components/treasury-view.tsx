import type { ReactNode } from "react";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
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

const NONE = <span className="text-muted-foreground">-</span>;

/** Long hashes keep their first and last six characters, so two rows can still be told apart. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

function Hash({ hash }: { hash: string }) {
  return (
    <a
      href={transactionUrl(hash)}
      target="_blank"
      rel="noreferrer"
      title={hash}
      className={`${linkClass} font-mono text-xs whitespace-nowrap`}
    >
      {shortHash(hash)}
    </a>
  );
}

function Id({ value }: { value: string | null }) {
  if (value === null) return NONE;
  return (
    <span
      title={value}
      className="block max-w-[14ch] truncate font-mono text-xs"
    >
      {value}
    </span>
  );
}

function Hashes({ hashes }: { hashes: readonly string[] }) {
  if (hashes.length === 0) return NONE;
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
    <section className="mt-5">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {empty === null ? (
        <div className="mt-2 overflow-x-auto rounded-lg border">{children}</div>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

const headCell =
  "bg-muted/50 px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground";
const cell = "px-3 py-2 align-top";
const amountCell = `${cell} text-right tabular-nums whitespace-nowrap`;

function HeadRow({
  titles,
  amounts,
}: {
  titles: readonly string[];
  amounts: readonly string[];
}) {
  return (
    <tr>
      {titles.map((title) => (
        <th
          key={title}
          scope="col"
          className={`${headCell} ${amounts.includes(title) ? "text-right" : ""}`}
        >
          {title}
        </th>
      ))}
    </tr>
  );
}

function Quotes({ quotes }: { quotes: readonly StaffTreasuryQuote[] }) {
  return (
    <Evidence
      title="Intent quotes"
      empty={quotes.length === 0 ? "No quotes were taken." : null}
    >
      <table className="w-full text-left text-sm" aria-label="Intent quotes">
        <thead>
          <HeadRow
            titles={[
              "Quote",
              "Status",
              "1Click",
              "Sent",
              "Delivered",
              "Refunded",
              "Transactions",
            ]}
            amounts={["Sent", "Delivered", "Refunded"]}
          />
        </thead>
        <tbody>
          {quotes.map((quote) => (
            <tr key={quote.id} className="border-t">
              <td className={cell}>
                <Link href={`/intent-quotes/${quote.id}`} className={linkClass}>
                  {INTENT_QUOTE_PURPOSE_LABELS[quote.purpose]}
                </Link>
                <span className="block text-xs whitespace-nowrap text-muted-foreground">
                  {formatNairobiTime(quote.createdAt)}
                </span>
              </td>
              <td className={cell}>
                <IntentQuoteStatusBadge status={quote.status} />
                {quote.failure ? (
                  <span className="mt-1 block text-xs">{quote.failure}</span>
                ) : null}
              </td>
              <td className={cell}>{quote.oneClickStatus ?? NONE}</td>
              <td className={amountCell}>{formatUsdc(quote.amountIn)}</td>
              <td className={amountCell}>
                {quote.swappedAmountOut
                  ? formatUsdc(quote.swappedAmountOut)
                  : `${formatUsdc(quote.amountOut)} quoted`}
              </td>
              <td className={amountCell}>
                {quote.refundedAmount ? formatUsdc(quote.refundedAmount) : NONE}
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
          <HeadRow
            titles={[
              "Kind",
              "Attempt",
              "Reference",
              "Status",
              "Amount",
              "Delivered",
              "Privy action",
              "Transaction",
            ]}
            amounts={["Amount", "Delivered"]}
          />
        </thead>
        <tbody>
          {earnActions.map((action) => (
            <tr key={action.id} className="border-t">
              <td className={cell}>{action.kind}</td>
              <td className={cell}>{action.attempt}</td>
              <td className={cell}>
                <Id value={action.referenceId} />
              </td>
              <td className={cell}>
                {action.status}
                {action.failure ? (
                  <span className="block text-xs">{action.failure}</span>
                ) : null}
              </td>
              <td className={amountCell}>{formatUsdc(action.rawAmount)}</td>
              <td className={amountCell}>
                {action.deliveredUsdc ? formatUsdc(action.deliveredUsdc) : NONE}
              </td>
              <td className={cell}>
                <Id value={action.privyActionId} />
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
          <HeadRow
            titles={["Time", "Type", "Amount", "Transaction"]}
            amounts={["Amount"]}
          />
        </thead>
        <tbody>
          {ledger.map((row) => (
            <tr key={row.id} className="border-t">
              <td className={`${cell} whitespace-nowrap`}>
                {formatNairobiTime(row.createdAt)}
              </td>
              <td className={cell}>{row.type}</td>
              <td className={amountCell}>{formatUsdc(row.usdcAmount)}</td>
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

/** A move that still needs someone opens expanded, so its staff action is in view. */
const MOVE_STARTS_OPEN: Record<StaffTreasuryMove["status"], boolean> = {
  open: true,
  needs_review: true,
  failed: false,
  returned: false,
  completed: false,
};

/** The summary row hides its figures on a phone, so the details repeat them there only. */
const phoneOnly = "sm:hidden";
const phoneOnlyLabel = "text-muted-foreground sm:hidden";

const moveGrid =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_1.25rem]";

function MoveFigure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="hidden text-right whitespace-nowrap tabular-nums sm:block">
      <span className="sr-only">{label} </span>
      {value}
      {note ? (
        <span className="block text-xs text-muted-foreground">{note}</span>
      ) : null}
    </div>
  );
}

function Move({
  move,
  actions,
}: {
  move: StaffTreasuryMove;
  actions: ReactNode;
}) {
  const label = DIRECTION_LABELS[move.direction];
  const settled = move.movedUsdc ? formatUsdc(move.movedUsdc) : "Not settled";
  const cost = move.costUsdc ? formatUsdc(move.costUsdc) : "Not settled";
  return (
    <details
      aria-label={`${label} ${move.id}`}
      open={MOVE_STARTS_OPEN[move.status]}
      className="group/move border-t first:border-t-0"
    >
      <summary
        className={`${moveGrid} cursor-pointer list-none px-4 py-3 text-sm hover:bg-muted/40 sm:px-6 [&::-webkit-details-marker]:hidden`}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{label}</h3>
            <StatusBadge tone={MOVE_TONES[move.status]}>
              {move.status.replace("_", " ")}
            </StatusBadge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatNairobiTime(move.createdAt)}
          </p>
        </div>
        <MoveFigure
          label="Asked"
          value={formatUsdc(move.requestedUsdc)}
          note={move.isAll ? "all of it" : undefined}
        />
        <MoveFigure
          label={move.direction === "to_treasury" ? "In the vault" : "Credited"}
          value={settled}
        />
        <MoveFigure label="Cost" value={cost} />
        <ChevronRightIcon
          aria-hidden
          className="size-4 justify-self-end text-muted-foreground transition-transform group-open/move:rotate-90"
        />
      </summary>
      <div className="bg-muted/20 px-4 pt-1 pb-5 sm:px-6">
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Move</dt>
          <dd className="font-mono text-xs leading-5 break-all">{move.id}</dd>
          <dt className={phoneOnlyLabel}>Asked</dt>
          <dd className={`${phoneOnly} tabular-nums`}>
            {move.isAll ? "All of it, " : ""}
            {formatUsdc(move.requestedUsdc)}
          </dd>
          <dt className={phoneOnlyLabel}>
            {move.direction === "to_treasury" ? "In the vault" : "Credited"}
          </dt>
          <dd className={`${phoneOnly} tabular-nums`}>{settled}</dd>
          <dt className={phoneOnlyLabel}>Cost</dt>
          <dd className={`${phoneOnly} tabular-nums`}>{cost}</dd>
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
        {actions ? <div className="mt-5">{actions}</div> : null}
      </div>
    </details>
  );
}

function Figure({
  label,
  value,
  lead = false,
}: {
  label: string;
  value: string;
  lead?: boolean;
}) {
  return (
    <div className="px-4 py-3 sm:px-5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 tabular-nums ${lead ? "text-xl font-semibold" : "text-base font-medium"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Position({ position }: { position: TreasuryOn["position"] }) {
  if (position.state === "unreadable") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-warn-600/30 bg-warn-50 px-4 py-3 text-sm text-warn-700"
      >
        Couldn&apos;t read Privy: {position.message}. The moves below are from
        Expendi&apos;s own records.
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-1 divide-y rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <Figure
        label="Value in the vault"
        value={formatUsdc(position.assetsInVault)}
        lead
      />
      <Figure
        label="Total deposited"
        value={formatUsdc(position.totalDeposited)}
      />
      <Figure
        label="Total withdrawn"
        value={formatUsdc(position.totalWithdrawn)}
      />
    </dl>
  );
}

function Alerts({ alerts }: { alerts: TreasuryOn["alerts"] }) {
  if (alerts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No open Treasury alerts.</p>
    );
  }
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-warn-600/30 bg-warn-50 px-4 py-3 text-sm text-warn-700"
    >
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <ul className="space-y-1">
        {alerts.map((alert) => (
          <li key={alert.id}>
            <Link
              href="/alerts"
              className="font-medium underline-offset-4 hover:underline"
            >
              {alert.title}
            </Link>{" "}
            <span className="text-xs opacity-80">
              open since {formatNairobiTime(alert.openedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
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
  const { position } = treasury;
  return (
    <div>
      <div className="space-y-4 px-4 py-5 sm:px-6">
        <Alerts alerts={treasury.alerts} />
        <Position position={position} />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Wallet on Base{" "}
            <a
              href={basescanAddressUrl(treasury.address)}
              target="_blank"
              rel="noreferrer"
              title={treasury.address}
              className={`${linkClass} font-mono`}
            >
              {shortHash(treasury.address)}
            </a>
          </span>
          <span>Turned on {formatNairobiTime(treasury.turnedOnAt)}</span>
          {position.state === "unreadable" ? null : (
            <span>Read from Privy {formatNairobiTime(position.readAt)}</span>
          )}
        </p>
      </div>
      <div className="border-t">
        <div
          className={`${moveGrid} px-4 py-2 text-xs font-medium text-muted-foreground sm:px-6`}
        >
          <h3>
            Moves <span className="font-normal">({treasury.moves.length})</span>
          </h3>
          <span className="hidden text-right sm:block">Asked</span>
          <span className="hidden text-right sm:block">Settled</span>
          <span className="hidden text-right sm:block">Cost</span>
          <span aria-hidden />
        </div>
        {treasury.moves.length === 0 ? (
          <p className="border-t px-4 py-4 text-sm text-muted-foreground sm:px-6">
            No moves yet.
          </p>
        ) : (
          <div className="border-t">
            {treasury.moves.map((move) => (
              <Move key={move.id} move={move} actions={renderActions(move)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
