"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";
import { cn } from "cn";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  InfoIcon,
  LockIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";

import type { ActivityEntry } from "@expendi-business/shared";

import type {
  ActivityRow,
  CalloutTone,
  ChangeRow,
  ShownValue,
} from "./activity-display";
import type { SheetStepper } from "~/components/data/detail-sheet";
import { TextLinkButton, textLinkClass } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SectionLabel,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { KesTotal, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { EntityMark } from "~/components/data/table";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import {
  ACTOR_ABOUT,
  amountOf,
  areaOf,
  batchCount,
  calloutOf,
  describeActor,
  describeChanges,
  entityTypeOf,
  kesTotalOf,
  recordKey,
  recordLink,
  recordName,
  rowTitle,
} from "./activity-display";
import { RowAmount } from "./activity-parts";

const CALLOUT_ICONS: Record<CalloutTone, LucideIcon> = {
  error: CircleAlertIcon,
  warn: TriangleAlertIcon,
  neutral: InfoIcon,
};

/**
 * An entry, or one approval's entries, in full: when, who, the record and
 * where it lives now, what changed field by field, and the values as
 * recorded. Nothing here can be changed.
 */
export function EntrySheet({
  row,
  stepper,
  filteredTo,
  onShowRecord,
  onClose,
}: {
  row: ActivityRow | undefined;
  stepper: SheetStepper;
  /** The record filter, so its own "All activity" link isn't offered. */
  filteredTo: string | null;
  onShowRecord: (entity: ActivityEntry["entity"]) => void;
  onClose: () => void;
}): JSX.Element {
  const lead = row?.subjects[0];
  if (!row || !lead) {
    return (
      <DetailSheet open={false} onClose={onClose} title="">
        {null}
      </DetailSheet>
    );
  }
  const batch = row.subjects.length > 1;
  const callout = batch ? null : calloutOf(lead);
  const CalloutIcon = callout ? CALLOUT_ICONS[callout.tone] : null;
  const actor = lead.actor;
  const about = actor.type === "user" ? null : ACTOR_ABOUT[actor.type];
  const changes = batch ? null : describeChanges(lead);

  return (
    <DetailSheet
      open
      onClose={onClose}
      eyebrow={areaOf(lead.action)?.label ?? "Activity"}
      title={rowTitle(row)}
      stepKey={row.id}
      stepper={stepper}
      headerExtra={
        <>
          <p className="mt-0.5 [overflow-wrap:anywhere] text-gray-600">
            {batch
              ? `${batchCount(row) ?? ""} with one passkey approval`
              : recordName(lead.entity)}
          </p>
          <div className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em] empty:hidden">
            <RowAmount row={row} size="inherit" />
          </div>
        </>
      }
      footer={
        <>
          <ReadOnlyNote icon={LockIcon}>
            Nothing here can be edited or deleted.
          </ReadOnlyNote>
          <SheetPosition index={stepper.index} total={stepper.total} />
        </>
      }
    >
      {callout && CalloutIcon ? (
        <Callout tone={callout.tone} icon={CalloutIcon} title={callout.title}>
          <p>{callout.text}</p>
        </Callout>
      ) : null}
      <DetailList>
        <DetailItem label="When" sub="Nairobi time">
          {formatNairobiDateTime(lead.occurredAt)}
        </DetailItem>
        <DetailItem label="Who" sub={about}>
          {describeActor(actor)}
        </DetailItem>
        {batch ? null : (
          <DetailItem
            label="Record"
            sub={
              <>
                {entityTypeOf(lead.entity.type).label}
                <RecordLinks
                  entry={lead}
                  filteredTo={filteredTo}
                  onShowRecord={onShowRecord}
                />
              </>
            }
          >
            {recordName(lead.entity)}
          </DetailItem>
        )}
        {row.approvalId ? (
          <DetailItem label="Passkey">
            Confirmed with {describeActor(actor)}&apos;s approval passkey
          </DetailItem>
        ) : null}
        <DetailItem label="Action">
          <span className="[overflow-wrap:anywhere] text-gray-600">
            {lead.action}
          </span>
        </DetailItem>
      </DetailList>
      {batch ? (
        <>
          <SectionLabel>
            {row.subjects.every((entry) => entry.entity.type === "bill")
              ? "Bills paid"
              : "Paid together"}
          </SectionLabel>
          <BatchList
            row={row}
            filteredTo={filteredTo}
            onShowRecord={onShowRecord}
          />
        </>
      ) : null}
      {changes && changes.rows.length > 0 ? (
        <>
          <SectionLabel>
            {changes.hasBefore ? "What changed" : "What was recorded"}
          </SectionLabel>
          <ChangesTable hasBefore={changes.hasBefore} rows={changes.rows} />
        </>
      ) : null}
      <RecordedValues row={row} />
    </DetailSheet>
  );
}

function RecordLinks({
  entry,
  filteredTo,
  onShowRecord,
  short = false,
}: {
  entry: ActivityEntry;
  filteredTo: string | null;
  onShowRecord: (entity: ActivityEntry["entity"]) => void;
  /** "All activity", inline after a batch line's detail. */
  short?: boolean;
}): JSX.Element | null {
  const link = recordLink(entry.entity, entry.action);
  const key = recordKey(entry.entity);
  const filterable = key !== null && key !== filteredTo;
  if (!link && !filterable) return null;
  return (
    <span
      className={cn(
        "flex flex-wrap gap-x-3.5 gap-y-1 text-xs leading-4",
        short ? "contents" : "mt-1.5",
      )}
    >
      {link ? (
        <Link
          href={link.href}
          className={cn(textLinkClass, "inline-flex items-center gap-1")}
        >
          Open in {link.page}
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
        </Link>
      ) : null}
      {filterable ? (
        <TextLinkButton onClick={() => onShowRecord(entry.entity)}>
          {short ? "All activity" : "All activity for this record"}
        </TextLinkButton>
      ) : null}
    </span>
  );
}

function BatchList({
  row,
  filteredTo,
  onShowRecord,
}: {
  row: ActivityRow;
  filteredTo: string | null;
  onShowRecord: (entity: ActivityEntry["entity"]) => void;
}): JSX.Element {
  const total = kesTotalOf(row.subjects);
  return (
    <ul
      aria-label="Paid together"
      className="m-0 list-none divide-y divide-hairline rounded-control border border-gray-200 p-0"
    >
      {row.subjects.map((entry) => {
        const [name = "", ...rest] = recordName(entry.entity).split(", ");
        const amount = amountOf(entry);
        return (
          <li
            key={entry.id}
            className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5"
          >
            <EntityMark name={name} />
            <span className="min-w-0">
              <span className="block truncate font-(--w-name)">{name}</span>
              <span className="flex flex-wrap gap-x-3 text-xs leading-4 text-gray-500">
                <span>
                  {rest.join(", ") || entityTypeOf(entry.entity.type).label}
                </span>
                <RecordLinks
                  entry={entry}
                  filteredTo={filteredTo}
                  onShowRecord={onShowRecord}
                  short
                />
              </span>
            </span>
            <span className="text-right font-(--w-amount) whitespace-nowrap">
              {amount ? (
                <Money amount={amount.amount} currency={amount.currency} />
              ) : null}
            </span>
          </li>
        );
      })}
      <li className="flex items-center justify-between gap-3 rounded-b-control bg-gray-25 px-3 py-2.5 text-gray-600">
        <span className="tabular-nums">{batchCount(row)}</span>
        {total ? (
          <span className="font-(--w-amount) text-gray-900">
            <KesTotal total={total} />
          </span>
        ) : null}
      </li>
    </ul>
  );
}

function Shown({ value }: { value: ShownValue }): JSX.Element {
  switch (value.kind) {
    case "none":
      return <span className="font-normal text-gray-500">None</span>;
    case "text":
      return <>{value.text}</>;
    case "money":
      return <Money amount={value.amount} currency={value.currency} />;
    case "status":
      return <StatusBadge tone={value.tone}>{value.label}</StatusBadge>;
  }
}

/** Before and after, field by field; the fields that changed in full colour. */
function ChangesTable({
  hasBefore,
  rows,
}: {
  hasBefore: boolean;
  rows: readonly ChangeRow[];
}): JSX.Element {
  const cell =
    "border-t border-hairline px-3 py-2.5 align-top [overflow-wrap:break-word]";
  const head =
    "border-b border-gray-200 bg-gray-25 px-3 py-2 text-left text-xs leading-4 font-(--w-ui) text-gray-500";
  return (
    <div className="overflow-hidden rounded-control border border-gray-200">
      <table className="w-full table-fixed border-separate border-spacing-0 [&_tbody_tr:first-child_td]:border-t-0">
        <colgroup>
          <col className="w-[32%]" />
          <col />
          {hasBefore ? <col /> : null}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={head}>
              Field
            </th>
            {hasBefore ? (
              <>
                <th scope="col" className={head}>
                  Before
                </th>
                <th scope="col" className={head}>
                  After
                </th>
              </>
            ) : (
              <th scope="col" className={head}>
                Recorded
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className={cn(cell, "text-gray-500")}>{row.label}</td>
              {hasBefore ? (
                <td className={cn(cell, "text-gray-600")}>
                  {row.before ? (
                    <Shown value={row.before} />
                  ) : (
                    <span className="sr-only">Not recorded</span>
                  )}
                </td>
              ) : null}
              <td
                className={cn(
                  cell,
                  row.changed
                    ? "font-(--w-ui) text-gray-900"
                    : row.before
                      ? "text-gray-600"
                      : "text-gray-900",
                )}
              >
                <Shown value={row.after} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The values exactly as the log holds them, for anyone who needs the IDs. */
function RecordedValues({ row }: { row: ActivityRow }): JSX.Element {
  const value =
    row.entries.length > 1
      ? row.entries.map((entry) => ({
          action: entry.action,
          entity: { type: entry.entity.type, id: entry.entity.id },
          before: entry.before,
          after: entry.after,
        }))
      : {
          before: row.entries[0]?.before ?? null,
          after: row.entries[0]?.after ?? null,
        };
  return (
    <details className="group/raw rounded-control border border-gray-200">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-control px-3 py-2.5 font-(--w-ui) text-gray-600 hover:text-gray-900 [&::-webkit-details-marker]:hidden">
        Recorded values
        <ChevronDownIcon
          aria-hidden="true"
          className="ml-auto size-4 text-gray-500 transition-transform duration-200 group-open/raw:rotate-180"
        />
      </summary>
      <pre className="m-0 max-h-80 overflow-auto rounded-b-control border-t border-hairline bg-gray-25 p-3 text-xs leading-4 whitespace-pre-wrap text-gray-700 tabular-nums [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
