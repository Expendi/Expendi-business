"use client";

import type { JSX, ReactNode } from "react";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  LandmarkIcon,
} from "lucide-react";
import { useState } from "react";

import type {
  TreasuryMoveDirection,
  TreasuryMoveSummary,
  TreasuryStatus,
} from "@expendi-business/shared";

import { Callout } from "~/components/data/detail-sheet";
import { ErrorState, Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/money";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { wholeKes } from "./balance-card";
import { useTreasury, useTreasuryMoves } from "./treasury-api";
import {
  formatRate,
  MOVE_HISTORY_TITLES,
  MOVE_STATUS_BADGES,
} from "./treasury-display";
import { MoveSheet, RATE_WARNING, TurnOnSheet } from "./treasury-sheets";
import { splitUsdc } from "./wallet-display";

type On = Extract<TreasuryStatus, { status: "on" }>;
type Off = Extract<TreasuryStatus, { status: "off" }>;

type OpenSheet = "turn-on" | TreasuryMoveDirection | null;

/**
 * The Treasury account on the Accounts page, under the company wallet. Not
 * shown while no vault is configured. It is never added into the wallet's
 * balance: Treasury can't be spent until it is moved back.
 */
export function TreasuryAccount({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element | null {
  const treasury = useTreasury(organizationId);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const status = treasury.data;
  const moves = useTreasuryMoves(organizationId, status?.status === "on");

  if (treasury.isPending) return <TreasurySkeleton />;
  if (treasury.isError) {
    return (
      <Card className="gap-0 py-0 shadow-xs">
        <ErrorState
          title="Treasury didn't load"
          onRetry={() => void treasury.refetch()}
        >
          {describeApiError(treasury.error)}
        </ErrorState>
      </Card>
    );
  }
  if (status?.status === "unavailable" || !status) return null;

  const rateBps = status.rateBps;
  return (
    <>
      <TreasuryCard
        status={status}
        moves={moves.data ?? null}
        movesFailed={moves.isError}
        canAct={canAct}
        onTurnOn={() => setSheet("turn-on")}
        onMove={setSheet}
      />
      {canAct ? (
        <>
          <TurnOnSheet
            key={sheet === "turn-on" ? "turn-on-open" : "turn-on-closed"}
            open={sheet === "turn-on"}
            organizationId={organizationId}
            rateBps={rateBps}
            onClose={() => setSheet(null)}
          />
          <MoveSheet
            key={sheet === "to_treasury" ? "in-open" : "in-closed"}
            open={sheet === "to_treasury"}
            organizationId={organizationId}
            direction="to_treasury"
            rateBps={rateBps}
            onClose={() => setSheet(null)}
          />
          <MoveSheet
            key={sheet === "to_wallet" ? "out-open" : "out-closed"}
            open={sheet === "to_wallet"}
            organizationId={organizationId}
            direction="to_wallet"
            rateBps={rateBps}
            onClose={() => setSheet(null)}
          />
        </>
      ) : null}
    </>
  );
}

function TreasurySkeleton(): JSX.Element {
  return (
    <Card aria-busy="true" className="gap-3 p-6 shadow-xs">
      <Skel width="25%" height={18} />
      <Skel width="40%" height={36} style={{ marginTop: 8 }} />
      <Skel width="100%" height={14} />
    </Card>
  );
}

/** One state of the account: the invitation, or the figures, an open move and the history. */
export function TreasuryCard({
  status,
  moves,
  movesFailed = false,
  canAct,
  onTurnOn,
  onMove,
}: {
  status: Exclude<TreasuryStatus, { status: "unavailable" }>;
  moves: readonly TreasuryMoveSummary[] | null;
  movesFailed?: boolean;
  canAct: boolean;
  onTurnOn: () => void;
  onMove: (direction: TreasuryMoveDirection) => void;
}): JSX.Element {
  return (
    <Card
      role="region"
      aria-labelledby="treasury-title"
      className="gap-0 py-5 shadow-xs max-[600px]:py-4"
    >
      <CardHeader className="flex items-center gap-2.5 border-b pb-4">
        <CardTitle className="text-lg">
          <h2 id="treasury-title">Treasury</h2>
        </CardTitle>
        <Badge variant="secondary">
          {status.status === "on" ? "Not spendable" : "Off"}
        </Badge>
      </CardHeader>
      <CardContent className="pt-4">
        {status.status === "on" ? (
          <TreasuryOn
            status={status}
            moves={moves}
            movesFailed={movesFailed}
            canAct={canAct}
            onMove={onMove}
          />
        ) : (
          <TreasuryInvitation
            status={status}
            canAct={canAct}
            onTurnOn={onTurnOn}
          />
        )}
      </CardContent>
    </Card>
  );
}

function RateLine({ rateBps }: { rateBps: number | null }): JSX.Element {
  return rateBps === null ? (
    <p className="text-muted-foreground">
      The rate isn&apos;t available right now.
    </p>
  ) : (
    <>
      <p className="flex items-baseline gap-1.5 tabular-nums">
        <span className="text-[24px] leading-8 font-(--w-heading) tracking-[-0.02em]">
          {formatRate(rateBps)}
        </span>
        <span className="text-sm text-muted-foreground">a year</span>
      </p>
      <p className="text-xs leading-4 text-muted-foreground">
        Rate {RATE_WARNING}.
      </p>
    </>
  );
}

function TreasuryInvitation({
  status,
  canAct,
  onTurnOn,
}: {
  status: Off;
  canAct: boolean;
  onTurnOn: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0 max-w-[52ch]">
        <p className="text-secondary-foreground">
          Move USDC the company doesn&apos;t need to spend right now into
          Treasury, where it collects yield. It can&apos;t be spent until it is
          moved back to the wallet.
        </p>
        <div className="mt-4">
          <p className="text-sm font-(--w-ui) text-muted-foreground">
            Current rate
          </p>
          <RateLine rateBps={status.rateBps} />
        </div>
      </div>
      {canAct ? (
        <Button onClick={onTurnOn}>
          <LandmarkIcon aria-hidden="true" />
          Turn on Treasury
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only admins can turn on Treasury.
        </p>
      )}
    </div>
  );
}

function TreasuryOn({
  status,
  moves,
  movesFailed,
  canAct,
  onMove,
}: {
  status: On;
  moves: readonly TreasuryMoveSummary[] | null;
  movesFailed: boolean;
  canAct: boolean;
  onMove: (direction: TreasuryMoveDirection) => void;
}): JSX.Element {
  const [whole, cents] = status.valueUsdc
    ? splitUsdc(status.valueUsdc)
    : ["—", ""];
  const open = status.openMove;
  return (
    <div className="flex flex-col gap-5">
      {status.saved ? (
        <Callout tone="neutral">
          <p>
            {status.asOf
              ? `These figures are from ${formatNairobiDateTime(status.asOf)}. Expendi can't read Treasury's live value right now.`
              : "Expendi can't read Treasury's value right now, and has no saved figures yet."}
          </p>
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="text-sm font-(--w-ui) text-muted-foreground">
            In Treasury
          </p>
          <p className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[32px] leading-10 font-(--w-display) tracking-[-0.025em] text-foreground">
              {whole}
              <span className="text-muted-foreground/70">{cents}</span>
            </span>
            <span className="text-sm font-(--w-ui) tracking-[0.04em] text-muted-foreground">
              USDC
            </span>
          </p>
          {status.kesEquivalent ? (
            <p className="mt-0.5 text-muted-foreground tabular-nums">
              <span className="text-[0.72em] font-(--w-ui) tracking-[0.04em]">
                ≈ KES
              </span>{" "}
              {wholeKes(status.kesEquivalent.kesCents)}
            </p>
          ) : null}
        </div>
        <dl className="flex gap-8">
          <div>
            <dt className="text-xs leading-4 text-muted-foreground">
              Yield so far
            </dt>
            <dd className="mt-1 whitespace-nowrap tabular-nums">
              {status.yieldUsdc === null ? (
                "—"
              ) : (
                <>
                  <SignedYield units={status.yieldUsdc} />{" "}
                  <span className="text-[0.72em] font-(--w-ui) tracking-[0.04em] text-muted-foreground">
                    USDC
                  </span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs leading-4 text-muted-foreground">
              Rate a year
            </dt>
            <dd className="mt-1 tabular-nums">
              {status.rateBps === null ? "—" : formatRate(status.rateBps)}
              <span className="block text-xs leading-4 text-muted-foreground">
                {RATE_WARNING}
              </span>
            </dd>
          </div>
        </dl>
      </div>
      {open ? (
        <Callout
          tone={open.status === "needs_review" ? "warn" : "neutral"}
          title={open.statusText}
        >
          <p className="tabular-nums">
            {openMoveText(open)}. You can start another move when this one ends.
          </p>
        </Callout>
      ) : null}
      {canAct ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={open !== null}
            onClick={() => onMove("to_treasury")}
          >
            <ArrowUpRightIcon aria-hidden="true" />
            Move to Treasury
          </Button>
          <Button
            variant="outline"
            disabled={open !== null}
            onClick={() => onMove("to_wallet")}
          >
            <ArrowDownLeftIcon aria-hidden="true" />
            Move to wallet
          </Button>
        </div>
      ) : null}
      <TreasuryMoves moves={moves} failed={movesFailed} />
    </div>
  );
}

function openMoveText(open: NonNullable<On["openMove"]>): string {
  const amount = `${formatUsdc(open.amountUsdc)} USDC`;
  if (open.direction === "to_treasury") return `${amount} to Treasury`;
  return open.isAll
    ? `All of Treasury (${amount}) to your wallet`
    : `${amount} to your wallet`;
}

function SignedYield({ units }: { units: string }): JSX.Element {
  const formatted = formatUsdc(units);
  return (
    <span>
      {formatted.startsWith("-") ? `−${formatted.slice(1)}` : `+${formatted}`}
    </span>
  );
}

/** Every move, newest first: what the admin asked, what arrived, what it cost. */
export function TreasuryMoves({
  moves,
  failed,
}: {
  moves: readonly TreasuryMoveSummary[] | null;
  failed: boolean;
}): JSX.Element {
  let content: ReactNode;
  if (failed) {
    content = (
      <p className="text-sm text-muted-foreground">
        The moves didn&apos;t load.
      </p>
    );
  } else if (moves === null) {
    content = <Skel width="100%" height={44} />;
  } else if (moves.length === 0) {
    content = (
      <p className="text-sm text-muted-foreground">
        No moves yet. Moves between the wallet and Treasury appear here.
      </p>
    );
  } else {
    content = (
      <ul>
        {moves.map((move) => (
          <MoveRow key={move.id} move={move} />
        ))}
      </ul>
    );
  }
  return (
    <section aria-labelledby="treasury-moves-title" className="border-t pt-4">
      <h3
        id="treasury-moves-title"
        className="mb-1 text-sm leading-5 font-(--w-ui) text-foreground"
      >
        Moves
      </h3>
      {content}
    </section>
  );
}

/**
 * What the move put where it was going, or what was asked while that isn't
 * known. A returned or failed move put nothing anywhere: its badge says so,
 * and the amount asked for is what the admin recognises.
 */
function amountShown(move: TreasuryMoveSummary): string {
  if (move.status === "returned" || move.status === "failed") {
    return move.requestedUsdc;
  }
  if (move.direction === "to_wallet") {
    return move.deliveredUsdc ?? move.movedUsdc ?? move.requestedUsdc;
  }
  return move.movedUsdc ?? move.requestedUsdc;
}

function moveDetail(move: TreasuryMoveSummary): string {
  const parts = [formatNairobiDateTime(move.createdAt)];
  if (move.isAll) parts.push("All of Treasury");
  if (move.costUsdc !== null && BigInt(move.costUsdc) > 0n) {
    parts.push(`Cost ${formatUsdc(move.costUsdc)} USDC`);
  }
  return parts.join(" · ");
}

function MoveRow({ move }: { move: TreasuryMoveSummary }): JSX.Element {
  const badge = MOVE_STATUS_BADGES[move.status];
  const Icon =
    move.direction === "to_treasury" ? ArrowUpRightIcon : ArrowDownLeftIcon;
  const shown = amountShown(move);
  const short =
    move.status === "completed" &&
    shown !== move.requestedUsdc &&
    BigInt(shown) < BigInt(move.requestedUsdc);
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-3 first:border-t-0">
      <span
        aria-hidden="true"
        className="inline-flex size-8 items-center justify-center rounded-control border border-border bg-card text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm leading-5 font-(--w-name) text-foreground">
          {MOVE_HISTORY_TITLES[move.direction]}
          {badge ? (
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          ) : null}
        </p>
        <p className="truncate text-xs leading-4 text-muted-foreground tabular-nums">
          {moveDetail(move)}
        </p>
        {short ? (
          <p className="text-xs leading-4 text-muted-foreground tabular-nums">
            {formatUsdc(shown)} of {formatUsdc(move.requestedUsdc)} USDC arrived
          </p>
        ) : null}
      </div>
      <p className="whitespace-nowrap tabular-nums">
        {formatUsdc(shown)}{" "}
        <span className="text-[0.72em] font-(--w-ui) tracking-[0.04em] text-muted-foreground">
          USDC
        </span>
      </p>
    </li>
  );
}
