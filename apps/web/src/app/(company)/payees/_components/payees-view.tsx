"use client";

import type { JSX } from "react";
import { useState } from "react";

import type { Payee, PayeeKind, PayeeMethod } from "@expendi-business/shared";
import { PAYEE_KINDS, PAYEE_METHODS } from "@expendi-business/shared";

import type { PayeeListFilters } from "~/features/payment-keys";
import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import {
  cellClass,
  headCellClass,
  inputClass,
  primaryButton,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { useDashboard } from "~/contexts/dashboard-context";
import {
  KIND_LABELS,
  listSummary,
  matchesSearch,
  METHOD_LABELS,
  RECENTLY_CHANGED_LABEL,
} from "~/features/payees/payee-display";
import {
  ACTIVE_PAYEES,
  usePayeeBanks,
  usePayees,
} from "~/features/payees/payees-api";
import { StatusBadge } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { NewPayeeForm } from "./payee-forms";
import { PayeeDetailPanel } from "./payee-panel";

type Panel =
  | { readonly kind: "detail"; readonly payeeId: string }
  | { readonly kind: "create" };

/**
 * The company's payees (spec §6.19): who it pays other than staff claims,
 * and how. Admins add payees and change their payment details with their
 * passkey; accountants see the same, read-only.
 */
export function PayeesView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyPayees
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyPayees({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const [filters, setFilters] = useState<PayeeListFilters>(ACTIVE_PAYEES);
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<Panel | null>(null);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Payees</h1>
          <p className="mt-1 text-sm text-stone-600">
            {canAct
              ? "Everyone the company pays besides staff claims. New payment details are confirmed with your passkey."
              : "Everyone the company pays besides staff claims, with their payment details. Only admins change them."}
          </p>
        </div>
        {canAct ? (
          <button
            type="button"
            onClick={() => setPanel({ kind: "create" })}
            className={primaryButton}
          >
            Add payee
          </button>
        ) : null}
      </div>

      <PayeeFilters
        filters={filters}
        search={search}
        onFilters={setFilters}
        onSearch={setSearch}
      />

      <div
        className={`mt-6 grid gap-6 ${panel ? "xl:grid-cols-2" : ""} xl:items-start`}
      >
        <PayeeTable
          organizationId={organizationId}
          filters={filters}
          search={search}
          selectedId={panel?.kind === "detail" ? panel.payeeId : null}
          onSelect={(payeeId) => setPanel({ kind: "detail", payeeId })}
        />
        {panel?.kind === "detail" ? (
          <div className="xl:sticky xl:top-8">
            <PayeeDetailPanel
              key={panel.payeeId}
              organizationId={organizationId}
              payeeId={panel.payeeId}
              canAct={canAct}
              onClose={() => setPanel(null)}
            />
          </div>
        ) : panel?.kind === "create" ? (
          <div className="rounded-lg border border-stone-200 bg-white p-4 xl:sticky xl:top-8">
            <ApprovalPasskeyGate>
              <NewPayeeForm
                organizationId={organizationId}
                onCreated={(payee) =>
                  setPanel({ kind: "detail", payeeId: payee.id })
                }
                onCancel={() => setPanel(null)}
              />
            </ApprovalPasskeyGate>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PayeeFilters({
  filters,
  search,
  onFilters,
  onSearch,
}: {
  filters: PayeeListFilters;
  search: string;
  onFilters: (filters: PayeeListFilters) => void;
  onSearch: (search: string) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Filter payees"
      className="mt-6 grid grid-cols-1 gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <label className="text-sm">
        Name
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search payees"
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        Kind
        <select
          value={filters.kind ?? ""}
          onChange={(event) =>
            onFilters({
              ...filters,
              kind:
                PAYEE_KINDS.find((kind) => kind === event.target.value) ?? null,
            })
          }
          className={inputClass}
        >
          <option value="">All kinds</option>
          {PAYEE_KINDS.map((kind: PayeeKind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Paid by
        <select
          value={filters.method ?? ""}
          onChange={(event) =>
            onFilters({
              ...filters,
              method:
                PAYEE_METHODS.find((method) => method === event.target.value) ??
                null,
            })
          }
          className={inputClass}
        >
          <option value="">Any method</option>
          {PAYEE_METHODS.map((method: PayeeMethod) => (
            <option key={method} value={method}>
              {METHOD_LABELS[method]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 self-end pb-1.5 text-sm">
        <input
          type="checkbox"
          checked={filters.archived}
          onChange={(event) =>
            onFilters({ ...filters, archived: event.target.checked })
          }
        />
        Show archived payees only
      </label>
    </div>
  );
}

function PayeeTable({
  organizationId,
  filters,
  search,
  selectedId,
  onSelect,
}: {
  organizationId: string;
  filters: PayeeListFilters;
  search: string;
  selectedId: string | null;
  onSelect: (payeeId: string) => void;
}): JSX.Element {
  const payees = usePayees(organizationId, filters);
  const needsBanks =
    payees.data?.some((payee) => payee.details?.method === "bank") ?? false;
  const banks = usePayeeBanks(organizationId, { enabled: needsBanks });
  const bankName = ({ details }: Payee): string | null => {
    if (details?.method !== "bank") return null;
    return (
      banks.data?.find((bank) => bank.code === details.bankCode)?.name ?? null
    );
  };

  if (payees.isPending) {
    return <p className="text-sm text-stone-500">Loading payees…</p>;
  }
  if (payees.isError) {
    return (
      <div className="text-sm text-error-700" role="alert">
        <p>{describeApiError(payees.error)}</p>
        <button
          type="button"
          onClick={() => void payees.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }

  const shown = payees.data.filter((payee) =>
    matchesSearch(payee.name, search),
  );
  if (shown.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        {payees.data.length === 0
          ? "No payees here yet."
          : "No payees match this search."}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Name
            </th>
            <th scope="col" className={headCellClass}>
              Kind
            </th>
            <th scope="col" className={headCellClass}>
              Paid by
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((payee) => (
            <tr
              key={payee.id}
              className={`border-t border-stone-200 align-top ${payee.id === selectedId ? "bg-brand-50" : ""}`}
            >
              <td className={cellClass}>
                <button
                  type="button"
                  onClick={() => onSelect(payee.id)}
                  aria-pressed={payee.id === selectedId}
                  className="text-left font-medium text-brand-700 underline-offset-4 hover:underline"
                >
                  {payee.name}
                </button>
                <span className="mt-1 flex flex-wrap gap-1">
                  {payee.archived ? (
                    <StatusBadge label="Archived" tone="neutral" />
                  ) : null}
                  {payee.secondConfirmationUntil ? (
                    <StatusBadge
                      label={RECENTLY_CHANGED_LABEL}
                      tone="warning"
                    />
                  ) : null}
                </span>
              </td>
              <td className={cellClass}>{KIND_LABELS[payee.kind]}</td>
              <td className={`${cellClass} break-all`}>
                {listSummary(payee, bankName(payee))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
