"use client";

import type { JSX, ReactNode } from "react";
import { useState } from "react";

import type { Invoice, InvoiceSummary } from "@expendi-business/shared";

import type { InvoiceAction } from "./invoice-detail";
import { DetailSheet } from "~/components/data/detail-sheet";
import { ErrorState } from "~/components/data/states";
import { useInvoice } from "~/features/invoices/invoices-api";
import {
  DeleteDraftForm,
  MarkPaidForm,
  MatchDepositForm,
  SendInvoiceForm,
  UndoPaymentForm,
  VoidInvoiceForm,
} from "./invoice-action-forms";
import {
  InvoiceDetailBody,
  InvoiceDetailFooter,
  InvoiceDetailSkeleton,
  InvoiceSheetHeader,
} from "./invoice-detail";
import { InvoiceForm } from "./invoice-form";

/** What the sheet shows that isn't in the URL: the new-invoice form or an action's form. */
export type InvoiceLocalSheet =
  | { readonly kind: "none" }
  | { readonly kind: "new-invoice" }
  | {
      readonly kind: "action";
      readonly invoiceId: string;
      readonly action: InvoiceAction;
      readonly paymentId?: string;
    };

export const NO_LOCAL_SHEET: InvoiceLocalSheet = { kind: "none" };

const ACTION_TITLES: Readonly<Record<InvoiceAction, string>> = {
  edit: "Edit invoice",
  send: "Send this invoice?",
  delete: "Delete this draft?",
  void: "Void this invoice?",
  mark_paid: "Mark paid",
  match: "Match a deposit",
  undo: "Undo this payment?",
};

interface SheetParts {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly headerExtra?: ReactNode;
  readonly stepper?: Parameters<typeof DetailSheet>[0]["stepper"];
  readonly stepKey: string;
  readonly body: ReactNode;
  readonly footer?: ReactNode;
  readonly footerSlot?: boolean;
}

/**
 * The Invoices page's side sheet: the new invoice form, or the open invoice
 * (`?invoice=`) with its detail, or the form of the action being taken on it.
 */
export function InvoiceSheet({
  organizationId,
  canAct,
  rows,
  invoiceId,
  local,
  onOpen,
  onLocal,
  onClose,
  onCreated,
}: {
  organizationId: string;
  canAct: boolean;
  /** The list as shown, to step through. */
  rows: readonly InvoiceSummary[];
  invoiceId: string | null;
  local: InvoiceLocalSheet;
  onOpen: (invoiceId: string) => void;
  onLocal: (local: InvoiceLocalSheet) => void;
  onClose: () => void;
  onCreated: (invoice: Invoice) => void;
}): JSX.Element {
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);
  const detail = useInvoice(organizationId, invoiceId ?? "", {
    enabled: invoiceId !== null,
  });
  const backToInvoice = () => onLocal(NO_LOCAL_SHEET);

  function invoiceParts(id: string): SheetParts {
    const row = rows.find((invoice) => invoice.id === id);
    const loaded = detail.data?.id === id ? detail.data : undefined;
    const summary: InvoiceSummary | undefined = loaded ?? row;
    const ids = rows.map((invoice) => invoice.id);
    const index = ids.indexOf(id);
    const action =
      local.kind === "action" && local.invoiceId === id ? local : null;

    if (action && loaded) {
      const props = {
        organizationId,
        invoice: loaded,
        footerSlot,
        onDone: backToInvoice,
      };
      const forms: Record<InvoiceAction, ReactNode> = {
        edit: (
          <InvoiceForm
            organizationId={organizationId}
            invoice={loaded}
            footerSlot={footerSlot}
            onSaved={backToInvoice}
            onCancel={backToInvoice}
          />
        ),
        send: <SendInvoiceForm {...props} />,
        delete: <DeleteDraftForm {...props} onDeleted={onClose} />,
        void: <VoidInvoiceForm {...props} />,
        mark_paid: <MarkPaidForm {...props} />,
        match: <MatchDepositForm {...props} />,
        undo: <UndoPaymentForm {...props} paymentId={action.paymentId ?? ""} />,
      };
      return {
        eyebrow: loaded.number,
        title: ACTION_TITLES[action.action],
        stepKey: `${action.action}:${id}`,
        body: forms[action.action],
        footerSlot: true,
      };
    }

    return {
      eyebrow: summary ? summary.customerName : "Invoice",
      title: summary?.number ?? "Invoice",
      headerExtra: summary ? <InvoiceSheetHeader invoice={summary} /> : null,
      stepper: {
        index,
        total: ids.length,
        onStep: (delta) => {
          const next = ids[index + delta];
          if (next) onOpen(next);
        },
        previousLabel: "Previous invoice",
        nextLabel: "Next invoice",
      },
      stepKey: id,
      body: loaded ? (
        <InvoiceDetailBody
          invoice={loaded}
          canAct={canAct}
          onUndo={(paymentId) =>
            onLocal({
              kind: "action",
              invoiceId: id,
              action: "undo",
              paymentId,
            })
          }
        />
      ) : detail.isError ? (
        <ErrorState
          title="This invoice didn't load"
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <InvoiceDetailSkeleton />
      ),
      footer: (
        <InvoiceDetailFooter
          organizationId={organizationId}
          invoice={loaded}
          canAct={canAct}
          index={index}
          total={ids.length}
          onAction={(next) =>
            onLocal({ kind: "action", invoiceId: id, action: next })
          }
        />
      ),
    };
  }

  const parts: SheetParts | null =
    local.kind === "new-invoice" && canAct
      ? {
          eyebrow: "Invoices",
          title: "New invoice",
          stepKey: "new-invoice",
          body: (
            <InvoiceForm
              organizationId={organizationId}
              invoice={null}
              footerSlot={footerSlot}
              onSaved={onCreated}
              onCancel={onClose}
            />
          ),
          footerSlot: true,
        }
      : invoiceId !== null
        ? invoiceParts(invoiceId)
        : null;

  return (
    <DetailSheet
      open={parts !== null}
      onClose={onClose}
      eyebrow={parts?.eyebrow}
      title={parts?.title ?? ""}
      headerExtra={parts?.headerExtra}
      stepper={parts?.stepper}
      stepKey={parts?.stepKey}
      footer={
        parts?.footerSlot ? (
          <div ref={setFooterSlot} className="contents" />
        ) : (
          parts?.footer
        )
      }
    >
      {parts?.body}
    </DetailSheet>
  );
}
