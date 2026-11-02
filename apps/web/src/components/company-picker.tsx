"use client";

import type { JSX } from "react";

import type { Company } from "~/contexts/company-context";
import { ROLE_LABELS } from "~/config/roles";
import { CenteredCard } from "./centered-card";
import { textButton } from "./styles";

export function CompanyPicker({
  companies,
  currentId,
  onSelect,
  onCancel,
  onSignOut,
}: {
  companies: Company[];
  currentId: string | null;
  onSelect: (organizationId: string) => void;
  /** Back to the current company, when there is one. */
  onCancel: (() => void) | null;
  onSignOut: () => void;
}): JSX.Element {
  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold">Choose a company</h1>
      <p className="mt-2 text-sm text-stone-600">
        You&apos;re in more than one company. Pick the one to work in; this
        browser remembers your choice.
      </p>
      <ul className="mt-6 space-y-2">
        {companies.map((company) => (
          <li key={company.organizationId}>
            <button
              type="button"
              onClick={() => onSelect(company.organizationId)}
              className="flex w-full items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-left hover:bg-stone-50"
            >
              <span>
                <span className="block text-sm font-medium">
                  {company.name}
                </span>
                <span className="block text-xs text-stone-500">
                  {ROLE_LABELS[company.role]}
                </span>
              </span>
              {company.organizationId === currentId ? (
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                  Current
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex justify-between">
        {onCancel ? (
          <button type="button" onClick={onCancel} className={textButton}>
            Cancel
          </button>
        ) : (
          <span />
        )}
        <button type="button" onClick={onSignOut} className={textButton}>
          Sign out
        </button>
      </div>
    </CenteredCard>
  );
}
