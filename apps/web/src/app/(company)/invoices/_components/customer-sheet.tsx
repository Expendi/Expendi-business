"use client";

import type { JSX } from "react";
import { useState } from "react";

import type { Customer } from "@expendi-business/shared";

import {
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { ErrorState } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { CustomerForm } from "./customer-form";

/** A customer's side sheet: the edit form for admins, the details for accountants. */
export function CustomerSheet({
  organizationId,
  canAct,
  customers,
  rows,
  customerId,
  creating,
  loading,
  onOpen,
  onClose,
}: {
  organizationId: string;
  canAct: boolean;
  /** Every customer, to find the open one even when the list filters it out. */
  customers: readonly Customer[];
  /** The list as shown, to step through. */
  rows: readonly Customer[];
  customerId: string | null;
  creating: boolean;
  /** The list hasn't loaded, so an unknown id may still turn up. */
  loading: boolean;
  onOpen: (customerId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);
  const customer = customers.find((candidate) => candidate.id === customerId);
  const ids = rows.map((candidate) => candidate.id);
  const index = customer ? ids.indexOf(customer.id) : -1;

  if (creating && canAct) {
    return (
      <DetailSheet
        open
        onClose={onClose}
        eyebrow="Customers"
        title="New customer"
        stepKey="new-customer"
        footer={<div ref={setFooterSlot} className="contents" />}
      >
        <CustomerForm
          organizationId={organizationId}
          customer={null}
          footerSlot={footerSlot}
          onSaved={onClose}
          onCancel={onClose}
        />
      </DetailSheet>
    );
  }

  return (
    <DetailSheet
      open={customerId !== null}
      onClose={onClose}
      eyebrow="Customer"
      title={customer?.name ?? "Customer"}
      headerExtra={
        customer?.archived ? (
          <StatusBadge tone="rejected" className="mt-2">
            Archived
          </StatusBadge>
        ) : null
      }
      stepper={{
        index,
        total: ids.length,
        onStep: (delta) => {
          const next = ids[index + delta];
          if (next) onOpen(next);
        },
        previousLabel: "Previous customer",
        nextLabel: "Next customer",
      }}
      stepKey={customerId ?? ""}
      footer={
        canAct ? (
          <div ref={setFooterSlot} className="contents" />
        ) : (
          <>
            <ReadOnlyNote>
              View only. Only admins change customers.
            </ReadOnlyNote>
            <SheetPosition index={index} total={ids.length} />
          </>
        )
      }
    >
      {customer ? (
        canAct ? (
          <CustomerForm
            key={customer.id}
            organizationId={organizationId}
            customer={customer}
            footerSlot={footerSlot}
            onSaved={onClose}
            onCancel={onClose}
          />
        ) : (
          <DetailList>
            <DetailItem label="Email">{customer.email}</DetailItem>
            <DetailItem label="Address">
              {customer.address ?? "None"}
            </DetailItem>
            <DetailItem label="Tax ID">{customer.taxId ?? "None"}</DetailItem>
          </DetailList>
        )
      ) : loading ? null : (
        <ErrorState
          title="This customer wasn't found"
          onRetry={onClose}
          retryLabel="Close"
        />
      )}
    </DetailSheet>
  );
}
