"use client";

import type { FormEvent, JSX } from "react";
import {
  ActivityIcon,
  ArrowDownIcon,
  BoxIcon,
  CalendarIcon,
  CircleAlertIcon,
  CogIcon,
  CopyIcon,
  FilterXIcon,
  KeyRoundIcon,
  LayersIcon,
  LifeBuoyIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";

import type { ActivityEntry, ActivityPage } from "@expendi-business/shared";
import { ACTIVITY_PAGE_SIZE } from "@expendi-business/shared";

import type { ActivityFilters } from "./activity-api";
import type { ActivityRow } from "./activity-display";
import type { FilterOption } from "~/components/data/filter-chip";
import { FilterChip } from "~/components/data/filter-chip";
import { PageHeader } from "~/components/data/page-header";
import {
  ResultsBody,
  ResultsFoot,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import {
  DataRow,
  DataTable,
  Mini,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  Td,
  Th,
} from "~/components/data/table";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { useActivity } from "./activity-api";
import {
  ACTIVITY_AREAS,
  batchCount,
  datePresets,
  dateRangeLabel,
  describeActor,
  entityTypeOf,
  groupRows,
  isPossibleDuplicate,
  isSelfApproved,
  nairobiToday,
  parseRecordKey,
  recordKey,
  recordName,
  rowMeta,
  rowTitle,
} from "./activity-display";
import { ActorMark, RowAmount } from "./activity-parts";
import { EntrySheet } from "./activity-sheet";

type ActivityParam = "area" | "person" | "record" | "from" | "to" | "id";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOM_DATES = "custom";

const NAIROBI_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const NAIROBI_DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  day: "numeric",
  month: "short",
});
const NAIROBI_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const AREA_OPTIONS: readonly FilterOption[] = ACTIVITY_AREAS.map((area) => ({
  value: area.prefix,
  label: area.label,
  icon: area.icon,
}));

const NOT_PEOPLE: readonly FilterOption[] = [
  { value: "system", label: "Expendi (automatic)", icon: CogIcon },
  { value: "staff", label: "Expendi team", icon: LifeBuoyIcon },
];

/** The people and records seen so far, for the Person and Record menus. */
interface Seen {
  readonly people: ReadonlyMap<string, string>;
  readonly records: ReadonlyMap<string, ActivityEntry["entity"]>;
}

function learn(seen: Seen, pages: readonly ActivityPage[]): Seen {
  const people = new Map(seen.people);
  const records = new Map(seen.records);
  for (const entry of pages.flatMap((page) => page.entries)) {
    if (entry.actor.id && entry.actor.name) {
      people.set(entry.actor.id, entry.actor.name);
    }
    const key = recordKey(entry.entity);
    if (key && entry.entity.type !== "payout") records.set(key, entry.entity);
  }
  return people.size === seen.people.size && records.size === seen.records.size
    ? seen
    : { people, records };
}

/**
 * The company's own audit log (spec §6.13, §6.14), read-only, for admins
 * and accountants: who changed what and when, newest first, one row for
 * everything one passkey approval did. Filters and the open entry live in
 * the URL.
 */
export function ActivityView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyActivity
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyActivity({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const [param, setParams] = useDeepLinkParams<ActivityParam>();
  const area = ACTIVITY_AREAS.find((option) => option.prefix === param("area"));
  const actorParam = param("person");
  const person =
    actorParam === "system" ||
    actorParam === "staff" ||
    (actorParam !== null && UUID.test(actorParam))
      ? actorParam
      : null;
  const record = parseRecordKey(param("record"));
  const fromParam = param("from");
  const toParam = param("to");
  const datesValid =
    (fromParam === null || ISO_DAY.test(fromParam)) &&
    (toParam === null || ISO_DAY.test(toParam)) &&
    !(fromParam && toParam && fromParam > toParam);
  const from = datesValid ? fromParam : null;
  const to = datesValid ? toParam : null;

  const filters: ActivityFilters = {
    ...(area ? { actionPrefix: area.prefix } : {}),
    ...(person ? { actor: person } : {}),
    ...(record ? { entityType: record.type, entityId: record.id } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const anyFilter = Object.keys(filters).length > 0;
  const filtersKey = JSON.stringify(filters);

  const result = useActivity(organizationId, filters);
  const [wanted, setWanted] = useState({
    key: filtersKey,
    count: ACTIVITY_PAGE_SIZE,
  });
  const target = wanted.key === filtersKey ? wanted.count : ACTIVITY_PAGE_SIZE;
  const entries = result.data?.pages.flatMap((page) => page.entries) ?? [];
  const loaded = entries.length;
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = result;

  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError &&
      loaded < target
    ) {
      void fetchNextPage();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loaded,
    target,
    fetchNextPage,
  ]);

  const pages = result.data?.pages;
  const [seen, setSeen] = useState<Seen & { pages?: readonly ActivityPage[] }>({
    people: new Map(),
    records: new Map(),
  });
  if (pages && pages !== seen.pages) {
    setSeen({ ...learn(seen, pages), pages });
  }

  const presets = datePresets(nairobiToday(new Date()));
  const dateLabel = dateRangeLabel(from, to, presets);
  const datePreset =
    from || to
      ? (presets.find((preset) => preset.from === from && preset.to === to)
          ?.value ?? CUSTOM_DATES)
      : null;

  const people: FilterOption[] = [
    ...[...seen.people]
      .map(([value, label]) => ({ value, label, mark: "person" as const }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    ...NOT_PEOPLE,
  ];
  const records: FilterOption[] = [...seen.records]
    .map(([value, entity]) => ({
      value,
      label: recordName(entity),
      icon: entityTypeOf(entity.type).icon,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const rows = groupRows(entries);
  const openId = param("id");
  const openIndex = openId
    ? rows.findIndex((row) => row.entries.some((entry) => entry.id === openId))
    : -1;
  const openRow = rows[openIndex];
  const stillLooking =
    rows.length === 0 &&
    (result.isPending || (hasNextPage && !isFetchNextPageError));

  const clearAll = () =>
    setParams({ area: null, person: null, record: null, from: null, to: null });
  const open = (row: ActivityRow) => setParams({ id: row.id });

  return (
    <section>
      <PageHeader
        title="Activity"
        subtitle="Every change to the company's money, people and settings, by whom and when, in Nairobi time. Nothing here can be edited or deleted."
      />
      <ResultsPanel label="Activity">
        <ResultsHead
          stacked
          tabs={null}
          chips={
            <>
              <FilterChip
                label="Area"
                icon={LayersIcon}
                options={AREA_OPTIONS}
                value={area?.prefix ?? null}
                onChange={(value) => setParams({ area: value })}
                anyLabel="Everything"
              />
              <FilterChip
                label="Person"
                icon={UserIcon}
                options={people}
                value={person}
                valueLabel={
                  person && !people.some((option) => option.value === person)
                    ? "Someone"
                    : undefined
                }
                onChange={(value) => setParams({ person: value })}
                anyLabel="Everyone"
                searchPlaceholder="Search people"
              />
              <FilterChip
                label="Record"
                icon={BoxIcon}
                options={records}
                value={record ? `${record.type}:${record.id}` : null}
                valueLabel={
                  record &&
                  !records.some(
                    (option) => option.value === `${record.type}:${record.id}`,
                  )
                    ? entityTypeOf(record.type).label
                    : undefined
                }
                onChange={(value) => setParams({ record: value })}
                anyLabel="Every record"
                searchPlaceholder="Search records"
              />
              <FilterChip
                label="Date"
                icon={CalendarIcon}
                options={[
                  ...presets.map((preset) => ({
                    value: preset.value,
                    label: preset.label,
                  })),
                  { value: CUSTOM_DATES, label: "Custom dates" },
                ]}
                value={datePreset}
                valueLabel={dateLabel ?? undefined}
                onChange={(value) => {
                  const preset = presets.find((p) => p.value === value);
                  setParams({
                    from: preset?.from ?? null,
                    to: preset?.to ?? null,
                  });
                }}
                anyLabel="Any time"
                custom={{
                  value: CUSTOM_DATES,
                  render: ({ done, back }) => (
                    <DateRangeForm
                      from={from}
                      to={to}
                      today={presets[0]?.to ?? ""}
                      onBack={back}
                      onApply={(range) => {
                        setParams(range);
                        done();
                      }}
                    />
                  ),
                }}
              />
            </>
          }
          onClearAll={anyFilter ? clearAll : undefined}
        />
        <ResultsBody busy={result.isPending}>
          {stillLooking ? (
            <ActivitySkeleton />
          ) : result.isError && rows.length === 0 ? (
            <ErrorState
              title="Activity didn't load"
              onRetry={() => void result.refetch()}
            >
              {describeApiError(result.error)}
            </ErrorState>
          ) : rows.length === 0 ? (
            anyFilter ? (
              <EmptyState
                icon={FilterXIcon}
                title="Nothing matches these filters"
                action={
                  <Button
                    variant="outline"
                    size="md"
                    className="mt-2"
                    onClick={clearAll}
                  >
                    Clear all
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ActivityIcon}
                title="No activity yet"
                action={
                  <Button asChild variant="outline" size="md" className="mt-2">
                    {canAct ? (
                      <Link href="/team">Invite your team</Link>
                    ) : (
                      <Link href="/overview">Go to Overview</Link>
                    )}
                  </Button>
                }
              >
                Changes to the company&apos;s money, people and settings show up
                here as they happen.
              </EmptyState>
            )
          ) : (
            <>
              <DataTable caption="Activity, newest first">
                <thead>
                  <tr>
                    <Th aria-sort="descending" className="w-px">
                      <span
                        title="Newest first"
                        className="inline-flex items-center gap-1 text-gray-900"
                      >
                        When
                        <ArrowDownIcon aria-hidden="true" className="size-3" />
                      </span>
                    </Th>
                    <Th>Who</Th>
                    <Th>What</Th>
                    <Th align="end">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <ActivityTableRow
                      key={row.id}
                      row={row}
                      open={row === openRow}
                      onOpen={() => open(row)}
                    />
                  ))}
                </tbody>
              </DataTable>
              <PhoneCards label="Activity">
                {rows.map((row) => (
                  <ActivityCard
                    key={row.id}
                    row={row}
                    onOpen={() => open(row)}
                  />
                ))}
              </PhoneCards>
              <ResultsFoot>
                <span className="tabular-nums" aria-live="polite">
                  {hasNextPage
                    ? `Showing ${String(rows.length)}, newest first`
                    : `Showing all ${String(rows.length)}`}
                </span>
                <span className="flex items-center gap-3">
                  {isFetchNextPageError ? (
                    <>
                      <span
                        role="alert"
                        className="inline-flex items-center gap-1.5 text-error-700"
                      >
                        <CircleAlertIcon
                          aria-hidden="true"
                          className="size-3.5"
                        />
                        More activity didn&apos;t load.
                      </span>
                      <Button
                        variant="outline"
                        size="md"
                        onClick={() => void fetchNextPage()}
                      >
                        Try again
                      </Button>
                    </>
                  ) : hasNextPage ? (
                    <Button
                      variant="outline"
                      size="md"
                      disabled={isFetchingNextPage}
                      onClick={() =>
                        setWanted({
                          key: filtersKey,
                          count: loaded + ACTIVITY_PAGE_SIZE,
                        })
                      }
                    >
                      {isFetchingNextPage ? "Loading…" : "Load more"}
                    </Button>
                  ) : null}
                </span>
              </ResultsFoot>
            </>
          )}
        </ResultsBody>
      </ResultsPanel>
      <EntrySheet
        row={openRow}
        stepper={{
          index: openIndex,
          total: rows.length,
          onStep: (delta) => {
            const next = rows[openIndex + delta];
            if (next) open(next);
          },
          previousLabel: "Previous entry",
          nextLabel: "Next entry",
        }}
        filteredTo={record ? `${record.type}:${record.id}` : null}
        onShowRecord={(entity) =>
          setParams({
            area: null,
            person: null,
            from: null,
            to: null,
            record: recordKey(entity),
            id: null,
          })
        }
        onClose={() => setParams({ id: null })}
      />
    </section>
  );
}

function RowMarkers({ row }: { row: ActivityRow }): JSX.Element {
  const count = batchCount(row);
  return (
    <>
      {count ? (
        <Mini icon={LayersIcon} label={count}>
          {count}
        </Mini>
      ) : null}
      {row.approvalId ? (
        <Mini icon={KeyRoundIcon} label="Confirmed with an approval passkey" />
      ) : null}
      {row.subjects.some(isSelfApproved) ? (
        <Mini icon={TriangleAlertIcon} label="Self-approved" warn>
          Self-approved
        </Mini>
      ) : null}
      {row.subjects.some(isPossibleDuplicate) ? (
        <Mini icon={CopyIcon} label="Possible duplicate" warn>
          Possible duplicate
        </Mini>
      ) : null}
    </>
  );
}

function ActivityTableRow({
  row,
  open,
  onOpen,
}: {
  row: ActivityRow;
  open: boolean;
  onOpen: () => void;
}): JSX.Element | null {
  const [lead] = row.entries;
  if (!lead) return null;
  const at = new Date(lead.occurredAt);
  return (
    <DataRow open={open} onOpen={onOpen}>
      <Td
        kind="date"
        title={`${NAIROBI_DAY.format(at)}, ${NAIROBI_CLOCK.format(at)}, Nairobi time`}
      >
        <span className="block text-gray-900">{NAIROBI_DAY.format(at)}</span>
        <span className="block text-gray-500">{NAIROBI_CLOCK.format(at)}</span>
      </Td>
      <Td>
        <span className="flex min-w-[196px] items-center gap-2.5 @max-[960px]/results:min-w-[174px]">
          <ActorMark actor={lead.actor} />
          <span className="min-w-0 text-gray-700">
            {describeActor(lead.actor)}
          </span>
        </span>
      </Td>
      <Td kind="main">
        <RowTitle onOpen={onOpen}>{rowTitle(row)}</RowTitle>
        <RowMeta text={rowMeta(row)}>
          <RowMarkers row={row} />
        </RowMeta>
      </Td>
      <Td align="end">
        <RowAmount row={row} />
      </Td>
    </DataRow>
  );
}

function ActivityCard({
  row,
  onOpen,
}: {
  row: ActivityRow;
  onOpen: () => void;
}): JSX.Element | null {
  const [lead] = row.entries;
  if (!lead) return null;
  const at = new Date(lead.occurredAt);
  return (
    <PhoneCard
      mark={<ActorMark actor={lead.actor} />}
      title={rowTitle(row)}
      sub={`${NAIROBI_DAY_MONTH.format(at)}, ${NAIROBI_CLOCK.format(at)} · ${describeActor(lead.actor)}`}
      flags={
        <>
          <span className="line-clamp-2 basis-full text-gray-500">
            {rowMeta(row)}
          </span>
          <RowMarkers row={row} />
        </>
      }
      aside={<RowAmount row={row} />}
      onOpen={onOpen}
    />
  );
}

const skeletonCell = "border-b border-row-divider px-4 py-3";

function ActivitySkeleton(): JSX.Element {
  return (
    <>
      <p className="sr-only">Loading activity…</p>
      <DataTable caption="Loading activity">
        <tbody>
          {Array.from({ length: 8 }, (_, row) => (
            <tr key={row} aria-hidden="true">
              <td className={skeletonCell}>
                <Skel width={84} height={14} />
                <Skel width={40} height={12} style={{ marginTop: 8 }} />
              </td>
              <td className={skeletonCell}>
                <span className="flex items-center gap-2.5">
                  <Skel width={32} height={32} className="rounded-full" />
                  <Skel width={110} height={14} />
                </span>
              </td>
              <td className={`${skeletonCell} w-full max-w-0`}>
                <Skel width="45%" height={14} />
                <Skel width="30%" height={12} style={{ marginTop: 8 }} />
              </td>
              <td className={skeletonCell}>
                <Skel width={96} height={14} style={{ marginLeft: "auto" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <PhoneCards label="Loading activity">
        {Array.from({ length: 5 }, (_, row) => (
          <li
            key={row}
            aria-hidden="true"
            className="flex items-center gap-3 border-b border-row-divider p-4"
          >
            <Skel width={32} height={32} className="rounded-full" />
            <span className="flex-1">
              <Skel width="55%" height={14} />
              <Skel width="40%" height={12} style={{ marginTop: 8 }} />
            </span>
          </li>
        ))}
      </PhoneCards>
    </>
  );
}

/** Custom dates: Nairobi calendar days, both included; one may be left open. */
function DateRangeForm({
  from,
  to,
  today,
  onBack,
  onApply,
}: {
  from: string | null;
  to: string | null;
  today: string;
  onBack: () => void;
  onApply: (range: { from: string | null; to: string | null }) => void;
}): JSX.Element {
  const fromId = useId();
  const toId = useId();
  const [error, setError] = useState<{
    field: "from" | "to";
    message: string;
  } | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = values.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const start = text("from");
    const end = text("to");
    const problem: { field: "from" | "to"; message: string } | null =
      !start && !end
        ? { field: "from", message: "Enter a start date, an end date or both." }
        : start && !ISO_DAY.test(start)
          ? { field: "from", message: "Use a date like 2026-11-02." }
          : end && !ISO_DAY.test(end)
            ? { field: "to", message: "Use a date like 2026-11-02." }
            : start && end && start > end
              ? {
                  field: "from",
                  message: "The start date is after the end date.",
                }
              : null;
    setError(problem);
    if (problem) {
      document
        .getElementById(problem.field === "from" ? fromId : toId)
        ?.focus();
      return;
    }
    onApply({ from: start || null, to: end || null });
  }

  return (
    <form
      aria-label="Custom dates"
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-3.5 p-3.5"
    >
      <p className="m-0 font-(--w-title)">Custom dates</p>
      <Field>
        <FieldLabel htmlFor={fromId}>From</FieldLabel>
        <Input
          id={fromId}
          name="from"
          type="date"
          max={today}
          defaultValue={from ?? ""}
          className="h-10 tabular-nums"
          aria-invalid={error?.field === "from" ? true : undefined}
          onChange={() => setError(null)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={toId}>To</FieldLabel>
        <Input
          id={toId}
          name="to"
          type="date"
          max={today}
          defaultValue={to ?? ""}
          className="h-10 tabular-nums"
          aria-invalid={error?.field === "to" ? true : undefined}
          onChange={() => setError(null)}
        />
      </Field>
      <FieldDescription>
        Days in Nairobi time, both included. Leave one empty for an open range.
      </FieldDescription>
      <FieldError>{error?.message}</FieldError>
      <div className="flex gap-2 *:flex-1">
        <Button type="submit" size="md">
          Apply
        </Button>
        <Button type="button" variant="outline" size="md" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}
