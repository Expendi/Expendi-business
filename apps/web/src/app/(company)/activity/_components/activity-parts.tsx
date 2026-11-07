"use client";

import type { JSX } from "react";
import { CogIcon, LifeBuoyIcon, UserXIcon } from "lucide-react";

import type { ActivityEntry } from "@expendi-business/shared";

import type { ActivityRow } from "./activity-display";
import { AmountStack, KesTotal, Money } from "~/components/data/money";
import { EntityMark } from "~/components/data/table";
import { amountOf, kesTotalOf } from "./activity-display";

export function ActorMark({
  actor,
}: {
  actor: ActivityEntry["actor"];
}): JSX.Element {
  if (actor.type === "user" && actor.name) {
    return <EntityMark name={actor.name} kind="person" />;
  }
  const Icon =
    actor.type === "system"
      ? CogIcon
      : actor.type === "staff"
        ? LifeBuoyIcon
        : UserXIcon;
  return (
    <span
      aria-hidden="true"
      className={
        actor.type === "user"
          ? "inline-flex size-8 flex-none items-center justify-center rounded-full border border-dashed border-gray-300 bg-surface text-gray-400"
          : "inline-flex size-8 flex-none items-center justify-center rounded-full bg-brand-50 text-brand-700"
      }
    >
      <Icon className="size-4" />
    </span>
  );
}

/** The row's amount: its own currency, or one KES total for a batch. */
export function RowAmount({
  row,
  size = "row",
}: {
  row: ActivityRow;
  size?: "row" | "inherit";
}): JSX.Element | null {
  const [lead] = row.subjects;
  if (row.subjects.length > 1) {
    const total = kesTotalOf(row.subjects);
    return total ? (
      <AmountStack size={size} align={size === "row" ? "end" : "start"}>
        <KesTotal total={total} />
      </AmountStack>
    ) : null;
  }
  const amount = lead ? amountOf(lead) : null;
  if (!amount) return null;
  return (
    <AmountStack size={size} align={size === "row" ? "end" : "start"}>
      <Money amount={amount.amount} currency={amount.currency} />
    </AmountStack>
  );
}
