import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import {
  CheckCircleIcon,
  ClockIcon,
  FileTextIcon,
  ReceiptTextIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";

import type { CashObligation } from "@expendi-business/shared";
import { obligationAction } from "@expendi-business/shared";

import type { InboxGroup, InboxItem } from "./overview-display";
import type { StatusTone } from "~/components/data/status-badge";
import { Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { EntityMark } from "~/components/data/table";
import { Button } from "~/components/ui/button";
import {
  dayMonth,
  expenseMeta,
  obligationHref,
  overdueLabel,
  paymentMeta,
} from "./overview-display";

const panelClass =
  "rounded-panel border border-gray-200 bg-surface shadow-panel";

/** Grouped rows of what needs someone today, each with its next step. */
export function Inbox({
  groups,
  canAct,
}: {
  groups: readonly InboxGroup[];
  canAct: boolean;
}): JSX.Element {
  let position = 0;
  return (
    <div
      className={`${panelClass} mt-6 overflow-hidden [animation-delay:70ms] motion-safe:animate-rise`}
    >
      {groups.map((group) => {
        const titleId = `inbox-${group.id}`;
        return (
          <section
            key={group.id}
            aria-labelledby={titleId}
            className="not-first:border-t not-first:border-gray-200"
          >
            <h2
              id={titleId}
              className="flex items-center gap-2 px-5 pt-4 pb-1 text-sm leading-5 font-(--w-ui) text-gray-600 max-[600px]:px-4"
            >
              {group.title}
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gray-100 px-1.5 text-xs text-gray-700 tabular-nums">
                {group.items.length}
              </span>
            </h2>
            <ul className="m-0 list-none p-0">
              {group.items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  canAct={canAct}
                  index={position++}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Pill({
  tone,
  icon: Icon,
  children,
}: {
  tone: StatusTone;
  icon: LucideIcon;
  children: ReactNode;
}): JSX.Element {
  return (
    <StatusBadge tone={tone} className="h-[22px] gap-1 pr-2 pl-1.5">
      <Icon aria-hidden="true" className="size-[13px]" />
      {children}
    </StatusBadge>
  );
}

function InboxRow({
  item,
  canAct,
  index,
}: {
  item: InboxItem;
  canAct: boolean;
  index: number;
}): JSX.Element {
  const view = rowView(item, canAct);
  return (
    <li
      style={{ animationDelay: `${String(120 + index * 45)}ms` }}
      className="grid grid-cols-[36px_minmax(0,1fr)] gap-3.5 px-5 pt-3.5 pb-4 transition-colors duration-150 not-first:border-t not-first:border-hairline hover:bg-gray-25 max-[600px]:gap-3 max-[600px]:px-4 motion-safe:animate-rise"
    >
      <span className="[&>span]:size-9">
        <EntityMark name={view.markName} kind={view.markKind} />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <Link
            href={view.href}
            className="min-w-0 rounded-[4px] text-base leading-6 font-(--w-name) [overflow-wrap:anywhere] text-gray-900 hover:underline hover:decoration-gray-300 hover:underline-offset-3"
          >
            {view.title}
          </Link>
          <span className="text-base leading-6 font-(--w-amount)">
            {view.amount}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm leading-5 text-gray-500">
          {view.meta ? <span>{view.meta}</span> : null}
          {view.pill}
        </div>
        {view.actions ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {view.actions}
          </div>
        ) : null}
      </div>
    </li>
  );
}

interface RowView {
  readonly markName: string;
  readonly markKind: "business" | "person";
  readonly title: string;
  readonly href: string;
  readonly amount: ReactNode;
  readonly meta: string;
  readonly pill: ReactNode;
  readonly actions: ReactNode;
}

function amountOf(row: CashObligation): ReactNode {
  if (row.amountKes !== null) {
    return <Money amount={row.amountKes} currency="KES" />;
  }
  return (
    <span className="text-sm font-normal text-gray-500">
      {row.needsAmount ? "Amount not entered" : "Amount unknown"}
    </span>
  );
}

function rowView(item: InboxItem, canAct: boolean): RowView {
  if (item.kind === "payment") {
    const { row } = item;
    const href = obligationHref(row);
    const viewLabel = row.kind === "payroll" ? "View run" : "View bill";
    return {
      markName: row.name,
      markKind: "business",
      title: row.name,
      href,
      amount: amountOf(row),
      meta: paymentMeta(row, item.overdueDays),
      pill:
        item.overdueDays > 0 ? (
          <Pill tone="overdue" icon={TriangleAlertIcon}>
            {overdueLabel(item.overdueDays)}
          </Pill>
        ) : (
          <Pill tone="waiting" icon={ClockIcon}>
            Due today
          </Pill>
        ),
      actions: (
        <>
          {canAct ? (
            <Button asChild size="md">
              <Link href={href}>{obligationAction(row)}</Link>
            </Button>
          ) : null}
          <Button asChild size="md" variant="ghost">
            <Link href={href}>{viewLabel}</Link>
          </Button>
        </>
      ),
    };
  }
  const { row } = item;
  if (item.kind === "claim") {
    const href = `/approvals?claimId=${row.id}`;
    return {
      markName: row.personName,
      markKind: "person",
      title: row.personName,
      href,
      amount: <Money amount={row.amountKes} currency="KES" />,
      meta: expenseMeta(row, "claim"),
      pill: null,
      actions: canAct ? (
        <Button asChild size="md">
          <Link href={href}>
            <CheckCircleIcon aria-hidden="true" />
            Review
          </Link>
        </Button>
      ) : (
        <Button asChild size="md" variant="ghost">
          <Link href={href}>View reimbursement</Link>
        </Button>
      ),
    };
  }
  const href = `/expenses?expenseId=${row.id}`;
  const holder = row.personName.trim().split(/\s+/)[0] ?? row.personName;
  return {
    markName: row.name,
    markKind: "business",
    title: row.name,
    href,
    amount: <Money amount={row.amountKes} currency="KES" />,
    meta: expenseMeta(row, item.kind),
    pill:
      item.kind === "receipt" ? (
        <Pill tone="waiting" icon={ReceiptTextIcon}>
          No receipt
        </Pill>
      ) : (
        <Pill tone="waiting" icon={FileTextIcon}>
          No eTIMS invoice
        </Pill>
      ),
    actions: (
      <>
        <Button asChild size="md" variant="outline">
          <Link href={href}>View expense</Link>
        </Button>
        <span className="text-sm text-gray-500">
          {holder} adds{" "}
          {item.kind === "receipt" ? "the receipt" : "the eTIMS invoice"} in the
          Expendi app.
        </span>
      </>
    ),
  };
}

/** Nothing waiting: say so, and what's paid next. */
export function CaughtUp({
  next,
}: {
  next: CashObligation | undefined;
}): JSX.Element {
  return (
    <div
      className={`${panelClass} mt-6 flex items-start gap-3.5 p-5 motion-safe:animate-rise`}
    >
      <CheckCircleIcon
        aria-hidden="true"
        className="size-6 shrink-0 text-success-700"
      />
      <div>
        <p>Nothing needs you right now.</p>
        {next ? (
          <p className="mt-0.5 text-gray-500 tabular-nums">
            Next payment: {next.name},{" "}
            {next.amountKes === null ? (
              "amount not entered"
            ) : (
              <Money amount={next.amountKes} currency="KES" />
            )}{" "}
            on {dayMonth(next.dueOn)}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
