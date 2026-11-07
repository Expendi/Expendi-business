"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { ChevronDownIcon, InfoIcon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";

import type { ClaimApproval } from "@expendi-business/shared";

import type { PreviewValue } from "./payment";
import { textLinkClass } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { EntityMark } from "~/components/data/table";
import { PASSKEY_HINT } from "~/features/payment-ui";
import { previewRows } from "./payment";

/** More previews than this start folded, so the totals stay in view. */
const OPEN_PREVIEWS_UP_TO = 3;

function Note({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}): JSX.Element {
  return (
    <p className="flex items-start gap-2 text-gray-600">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-gray-500"
      />
      <span>{children}</span>
    </p>
  );
}

function Changed({
  changed,
  children,
}: {
  changed: boolean;
  children: ReactNode;
}): JSX.Element {
  return changed ? (
    <span className="-mx-1 rounded-[4px] bg-warn-50 px-1">{children}</span>
  ) : (
    <>{children}</>
  );
}

function PreviewAmount({
  value,
  changed,
}: {
  value: PreviewValue;
  changed: boolean;
}): JSX.Element {
  if (value.kind === "text") return <>{value.text}</>;
  if (value.kind === "usdc") {
    return (
      <Changed changed={changed}>
        <Money amount={value.units} currency="USDC" />
      </Changed>
    );
  }
  return (
    <>
      <Money amount={value.cents} currency="KES" />
      {value.note ? `, ${value.note}` : null}
    </>
  );
}

/**
 * What the admin confirms with their passkey (spec §6.7 step 2): each
 * reimbursement's payment, the totals and the wallet. A short wallet
 * blocks paying ("Top up KES X", step 4). `costChanged` marks the USDC
 * figures a fresh quote moved.
 */
export function PaymentReview({
  approval,
  merchantOf,
  costChanged,
  cancelled,
}: {
  approval: ClaimApproval;
  /** What each reimbursement was spent on, by its id. */
  merchantOf: (claimId: string) => string | undefined;
  costChanged: boolean;
  cancelled: boolean;
}): JSX.Element {
  const topUpKes = approval.wallet.topUpKes;
  return (
    <>
      {costChanged ? (
        <div role="alert">
          <Callout tone="warn">
            <p>
              The cost changed since you reviewed it. Nothing was sent. Review
              it again.
            </p>
          </Callout>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {approval.claims.map((preview) => (
          <details
            key={preview.claimId}
            open={approval.claims.length <= OPEN_PREVIEWS_UP_TO}
            className="group/preview rounded-control border border-gray-200"
          >
            <summary className="grid cursor-pointer list-none grid-cols-[32px_minmax(0,1fr)_auto_16px] items-center gap-3 rounded-control px-3 py-2.5 [&::-webkit-details-marker]:hidden">
              <EntityMark name={preview.claimantName} kind="person" />
              <span className="min-w-0">
                <span className="block truncate font-(--w-name)">
                  {preview.claimantName}
                </span>
                <span className="block truncate text-xs leading-4 text-gray-500">
                  {merchantOf(preview.claimId)}
                </span>
              </span>
              <span className="text-right font-(--w-amount) whitespace-nowrap">
                <Money amount={preview.receivesKes} currency="KES" />
              </span>
              <ChevronDownIcon
                aria-hidden="true"
                className="size-4 text-gray-500 transition-transform duration-200 ease-out-expo group-open/preview:rotate-180"
              />
            </summary>
            <div className="mr-3 mb-3 ml-14 border-t border-hairline pt-[9px] max-[600px]:ml-3">
              <DetailList labelWidth="lg">
                {previewRows(preview).map((row) => (
                  <DetailItem key={row.label} label={row.label}>
                    <PreviewAmount value={row.value} changed={costChanged} />
                  </DetailItem>
                ))}
              </DetailList>
            </div>
          </details>
        ))}
      </div>
      <dl className="grid grid-cols-3 gap-3 rounded-control bg-gray-50 px-4 py-3.5 max-[600px]:grid-cols-1">
        <div>
          <dt className="text-xs leading-4 font-(--w-ui) text-gray-500">
            They receive, in total
          </dt>
          <dd className="mt-1 text-base leading-6 font-(--w-amount)">
            <Money amount={approval.totals.receivesKes} currency="KES" />
          </dd>
        </div>
        <div>
          <dt className="text-xs leading-4 font-(--w-ui) text-gray-500">
            Total, at most
          </dt>
          <dd className="mt-1 text-base leading-6 font-(--w-amount)">
            <Changed changed={costChanged}>
              <Money amount={approval.totals.maxDebitUsdc} currency="USDC" />
            </Changed>
          </dd>
        </div>
        <div>
          <dt className="text-xs leading-4 font-(--w-ui) text-gray-500">
            In the wallet
          </dt>
          <dd className="mt-1 text-base leading-6 font-(--w-amount)">
            <Money amount={approval.wallet.availableUsdc} currency="USDC" />
          </dd>
        </div>
      </dl>
      <Note icon={InfoIcon}>
        Paycrest states its exact fee when each payment is made. What isn’t used
        stays in the wallet. Each one is paid on its own.
      </Note>
      {topUpKes ? (
        <Callout
          tone="warn"
          title={
            <>
              Top up <Money amount={topUpKes} currency="KES" />
            </>
          }
        >
          <p>
            The wallet doesn’t hold enough USDC for this. Add funds, then review
            it again.{" "}
            <Link href="/wallet" className={textLinkClass}>
              Go to Accounts
            </Link>
          </p>
        </Callout>
      ) : (
        <Note icon={KeyRoundIcon}>{PASSKEY_HINT}</Note>
      )}
      {cancelled ? (
        <Note icon={InfoIcon}>Cancelled. Nothing was sent.</Note>
      ) : null}
    </>
  );
}
