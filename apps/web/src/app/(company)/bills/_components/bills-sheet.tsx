"use client";

import type { JSX, ReactNode } from "react";
import { useMemo, useState } from "react";

import type {
  Bill,
  BillDetail,
  PayeeChangeHold,
  RecurringItem,
} from "@expendi-business/shared";

import type { BillAction } from "./bill-detail";
import type { RecurringConfirmKind } from "./recurring-sheet";
import type { SheetStepper } from "~/components/data/detail-sheet";
import type { BillPaymentRequest } from "~/features/bills/bill-payment";
import type { PreparedBillPayment } from "~/features/bills/bills-api";
import { TreasuryOfferButton } from "~/app/(company)/wallet/_components/treasury-offer";
import { DetailSheet } from "~/components/data/detail-sheet";
import { ErrorState } from "~/components/data/states";
import { nairobiIsoDate } from "~/features/bills/bill-dates";
import { useBill } from "~/features/bills/bills-api";
import { useReceiptDownload } from "~/features/bills/receipt-download";
import {
  useCreateRecurringItem,
  useRecurringItem,
  useRecurringItems,
  useUpdateRecurringItem,
} from "~/features/recurring/recurring-api";
import {
  blankDraft,
  draftFromItem,
  sortRecurringItems,
} from "~/features/recurring/recurring-draft";
import {
  BillDetailBody,
  BillDetailFooter,
  BillDetailSkeleton,
  billEyebrow,
  BillSheetHeader,
} from "./bill-detail";
import { BillForm } from "./bill-form";
import {
  PaymentHold,
  PaymentReview,
  paymentTitle,
} from "./bill-payment-review";
import {
  AddInvoicesForm,
  CancelBillForm,
  MarkPaidOutsideForm,
} from "./bill-settle-forms";
import { RecurringForm } from "./recurring-form";
import {
  BackToRecurring,
  CONFIRMATIONS,
  RecurringConfirm,
  RecurringDetailBody,
  RecurringDetailFooter,
  RecurringList,
  RecurringListFooter,
  RecurringSheetHeader,
} from "./recurring-sheet";

/** What the sheet shows that isn't in the URL: a form or a confirmation. */
export type LocalSheet =
  | { readonly kind: "none" }
  | { readonly kind: "new-bill" }
  | {
      readonly kind: "bill-action";
      readonly billId: string;
      readonly action: BillAction;
    }
  | { readonly kind: "recurring-new" }
  | { readonly kind: "recurring-edit"; readonly itemId: string }
  | {
      readonly kind: "recurring-confirm";
      readonly itemId: string;
      readonly confirm: RecurringConfirmKind;
    };

export const NO_LOCAL_SHEET: LocalSheet = { kind: "none" };

export type PaymentStep =
  | {
      readonly step: "hold";
      readonly request: BillPaymentRequest;
      readonly hold: PayeeChangeHold;
    }
  | { readonly step: "review"; readonly prepared: PreparedBillPayment };

/** The URL params the sheet moves between: the open bill, or the recurring payments. */
export interface SheetLink {
  readonly billId?: string | null;
  readonly recurring?: string | null;
  /** The tab, so an opened bill shows in the list. */
  readonly view?: string | null;
  readonly status?: string | null;
  /** `?new=1` opens the New bill form on arrival; it leaves the URL after. */
  readonly new?: null;
}

export interface PaymentControls {
  readonly step: PaymentStep | null;
  readonly preparing: boolean;
  readonly paying: boolean;
  readonly costChanged: boolean;
  readonly cancelled: boolean;
  /** Why a payment couldn't start or go through. */
  readonly error: string | null;
  /** What `error` was made from, for the "Move to wallet" offer on a short wallet. */
  readonly failure: unknown;
  readonly onPayBill: (bill: Bill) => void;
  readonly onConfirmHold: () => void;
  readonly onPay: () => void;
  readonly onCancel: () => void;
}

interface SheetParts {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly headerExtra?: ReactNode;
  readonly stepper?: SheetStepper;
  readonly stepKey: string;
  readonly body: ReactNode;
  readonly footer?: ReactNode;
  /** The body renders its own buttons into the footer. */
  readonly footerSlot?: boolean;
  readonly flush?: boolean;
  readonly dismissible?: boolean;
}

const LIST_SUBTITLE = (
  <p className="mt-0.5 text-muted-foreground">
    Set up once. Each one&apos;s next bill is always ready in To pay.
  </p>
);

/**
 * The Bills page's one side sheet. It shows, in this order of precedence,
 * a payment being reviewed, the new bill form, the open bill (`?billId=`)
 * with its forms, or the recurring payments (`?recurring=all` or an id)
 * with their details, forms and confirmations.
 */
export function BillsSheet({
  organizationId,
  canAct,
  canPay,
  needsPasskey,
  rate,
  rows,
  billId,
  recurring,
  local,
  payment,
  onNavigate,
  onLocal,
  onClose,
  onBillCreated,
}: {
  organizationId: string;
  canAct: boolean;
  canPay: boolean;
  needsPasskey: boolean;
  rate: string | null;
  /** The list as shown, to step through. */
  rows: readonly Bill[];
  billId: string | null;
  recurring: string | null;
  local: LocalSheet;
  payment: PaymentControls;
  onNavigate: (link: SheetLink, local?: LocalSheet) => void;
  onLocal: (local: LocalSheet) => void;
  onClose: () => void;
  onBillCreated: (bill: BillDetail) => void;
}): JSX.Element {
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);
  const receiptDownload = useReceiptDownload(organizationId);
  const detail = useBill(organizationId, billId ?? "", {
    enabled: billId !== null,
  });
  const items = useRecurringItems(organizationId, {
    enabled: recurring !== null,
  });
  const sortedItems = useMemo(
    () => (items.data ? sortRecurringItems(items.data) : undefined),
    [items.data],
  );
  const itemId = recurring !== null && recurring !== "all" ? recurring : null;
  const listed = itemId
    ? sortedItems?.find((item) => item.id === itemId)
    : undefined;
  const single = useRecurringItem(organizationId, itemId ?? "", {
    enabled: itemId !== null && items.isSuccess && listed === undefined,
  });
  const item = listed ?? single.data;

  const backToBill = () => onLocal(NO_LOCAL_SHEET);

  function billParts(id: string): SheetParts {
    const row = rows.find((bill) => bill.id === id);
    const loaded = detail.data?.id === id ? detail.data : undefined;
    const bill: Bill | undefined = loaded ?? row;
    const ids = rows.map((one) => one.id);
    const index = ids.indexOf(id);
    const action =
      local.kind === "bill-action" && local.billId === id ? local.action : null;

    if (action && loaded) {
      const titles: Record<BillAction, string> = {
        edit: "Edit bill",
        paid_outside: "Mark paid outside Expendi",
        cancel: "Cancel this bill?",
        invoice: "Add an invoice",
      };
      const forms: Record<BillAction, ReactNode> = {
        edit: (
          <BillForm
            organizationId={organizationId}
            bill={loaded}
            footerSlot={footerSlot}
            onSaved={backToBill}
            onCancel={backToBill}
          />
        ),
        paid_outside: (
          <MarkPaidOutsideForm
            organizationId={organizationId}
            bill={loaded}
            footerSlot={footerSlot}
            onDone={backToBill}
          />
        ),
        cancel: (
          <CancelBillForm
            organizationId={organizationId}
            bill={loaded}
            footerSlot={footerSlot}
            onDone={backToBill}
          />
        ),
        invoice: (
          <AddInvoicesForm
            organizationId={organizationId}
            bill={loaded}
            footerSlot={footerSlot}
            onDone={backToBill}
          />
        ),
      };
      return {
        eyebrow: loaded.payee.name,
        title: titles[action],
        stepKey: `${action}:${id}`,
        body: forms[action],
        footerSlot: true,
      };
    }

    return {
      eyebrow: bill ? billEyebrow(bill) : "Bill",
      title: bill?.payee.name ?? "Bill",
      headerExtra: bill ? <BillSheetHeader bill={bill} rate={rate} /> : null,
      stepper: {
        index,
        total: ids.length,
        onStep: (delta) => {
          const next = ids[index + delta];
          if (next) onNavigate({ billId: next });
        },
        previousLabel: "Previous bill",
        nextLabel: "Next bill",
      },
      stepKey: id,
      body: loaded ? (
        <BillDetailBody
          bill={loaded}
          error={payment.error}
          errorAction={<TreasuryOfferButton error={payment.failure} />}
          receiptDownload={receiptDownload}
          onSeeRecurring={(recurringId) =>
            onNavigate({ billId: null, recurring: recurringId })
          }
        />
      ) : detail.isError ? (
        <ErrorState
          title="This bill didn't load"
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <BillDetailSkeleton />
      ),
      footer: bill ? (
        <BillDetailFooter
          bill={bill}
          canAct={canAct}
          canPay={canPay}
          needsPasskey={needsPasskey}
          preparing={payment.preparing}
          paymentBusy={payment.preparing || payment.step !== null}
          index={index}
          total={ids.length}
          onPay={() => payment.onPayBill(bill)}
          onAction={(next) =>
            onLocal({ kind: "bill-action", billId: id, action: next })
          }
        />
      ) : null,
    };
  }

  function recurringListParts(): SheetParts {
    return {
      eyebrow: "Bills",
      title: "Recurring payments",
      headerExtra: LIST_SUBTITLE,
      stepKey: "recurring",
      flush: true,
      body: (
        <RecurringList
          items={sortedItems}
          error={items.error}
          canAct={canAct}
          onOpen={(id) => onNavigate({ recurring: id })}
          onNew={() => onLocal({ kind: "recurring-new" })}
          onRetry={() => void items.refetch()}
        />
      ),
      footer: (
        <RecurringListFooter
          canAct={canAct}
          canAdd={(sortedItems?.length ?? 0) > 0}
          onNew={() => onLocal({ kind: "recurring-new" })}
          onClose={onClose}
        />
      ),
    };
  }

  function recurringItemParts(found: RecurringItem): SheetParts {
    const ids = (sortedItems ?? []).map((one) => one.id);
    const index = ids.indexOf(found.id);
    const toDetail = () => onLocal(NO_LOCAL_SHEET);
    if (local.kind === "recurring-edit" && local.itemId === found.id) {
      return {
        eyebrow: found.payee.name,
        title: "Edit recurring payment",
        stepKey: `edit:${found.id}`,
        body: (
          <EditRecurring
            organizationId={organizationId}
            item={found}
            footerSlot={footerSlot}
            onDone={toDetail}
          />
        ),
        footerSlot: true,
      };
    }
    if (local.kind === "recurring-confirm" && local.itemId === found.id) {
      return {
        eyebrow: found.payee.name,
        title: CONFIRMATIONS[local.confirm].title,
        stepKey: `${local.confirm}:${found.id}`,
        body: (
          <RecurringConfirm
            organizationId={organizationId}
            item={found}
            kind={local.confirm}
            footerSlot={footerSlot}
            onDone={toDetail}
            onKeep={toDetail}
          />
        ),
        footerSlot: true,
      };
    }
    return {
      eyebrow: (
        <BackToRecurring onBack={() => onNavigate({ recurring: "all" })} />
      ),
      title: found.payee.name,
      headerExtra: <RecurringSheetHeader item={found} />,
      stepper: {
        index,
        total: ids.length,
        onStep: (delta) => {
          const next = ids[index + delta];
          if (next) onNavigate({ recurring: next });
        },
        previousLabel: "Previous payment",
        nextLabel: "Next payment",
      },
      stepKey: found.id,
      body: (
        <RecurringDetailBody
          item={found}
          onOpenBill={(nextBillId) =>
            onNavigate({
              recurring: null,
              billId: nextBillId,
              view: found.nextBill?.status === "paying" ? "paying" : null,
              status: null,
            })
          }
        />
      ),
      footer: (
        <RecurringDetailFooter
          organizationId={organizationId}
          item={found}
          canAct={canAct}
          index={index}
          total={ids.length}
          onEdit={() => onLocal({ kind: "recurring-edit", itemId: found.id })}
          onConfirm={(confirm) =>
            onLocal({ kind: "recurring-confirm", itemId: found.id, confirm })
          }
        />
      ),
    };
  }

  function recurringParts(target: string): SheetParts {
    if (local.kind === "recurring-new" && canAct) {
      return {
        eyebrow: "Recurring payments",
        title: "New recurring payment",
        stepKey: "recurring-new",
        body: (
          <CreateRecurring
            organizationId={organizationId}
            footerSlot={footerSlot}
            onCreated={(created) =>
              onNavigate({ recurring: created.id }, NO_LOCAL_SHEET)
            }
            onCancel={() => onNavigate({ recurring: "all" })}
          />
        ),
        footerSlot: true,
      };
    }
    if (target === "all") return recurringListParts();
    if (item) return recurringItemParts(item);
    if (single.isError) {
      return {
        ...recurringListParts(),
        body: (
          <ErrorState
            title="This recurring payment didn't load"
            onRetry={() => void single.refetch()}
          />
        ),
      };
    }
    return { ...recurringListParts(), stepKey: `loading:${target}` };
  }

  function paymentParts(step: PaymentStep): SheetParts {
    if (step.step === "hold") {
      return {
        eyebrow: "Bills",
        title: "Payment details changed recently",
        stepKey: "payment-hold",
        body: (
          <PaymentHold
            hold={step.hold}
            preparing={payment.preparing}
            footerSlot={footerSlot}
            onConfirm={payment.onConfirmHold}
            onCancel={payment.onCancel}
          />
        ),
        footerSlot: true,
      };
    }
    const { prepared } = step;
    return {
      eyebrow: "Bills",
      title: paymentTitle(
        prepared.request.retry,
        prepared.payment.bills.length,
      ),
      stepKey: "payment-review",
      body: (
        <PaymentReview
          payment={prepared.payment}
          paying={payment.paying}
          costChanged={payment.costChanged}
          cancelled={payment.cancelled}
          footerSlot={footerSlot}
          onPay={payment.onPay}
          onCancel={payment.onCancel}
        />
      ),
      footerSlot: true,
      dismissible: !payment.paying,
    };
  }

  const parts: SheetParts | null = payment.step
    ? paymentParts(payment.step)
    : local.kind === "new-bill" && canAct
      ? {
          eyebrow: "Bills",
          title: "New bill",
          stepKey: "new-bill",
          body: (
            <BillForm
              organizationId={organizationId}
              bill={null}
              footerSlot={footerSlot}
              onSaved={onBillCreated}
              onCancel={onClose}
            />
          ),
          footerSlot: true,
        }
      : billId !== null
        ? billParts(billId)
        : recurring !== null
          ? recurringParts(recurring)
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
      flush={parts?.flush}
      dismissible={parts?.dismissible}
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

function CreateRecurring({
  organizationId,
  footerSlot,
  onCreated,
  onCancel,
}: {
  organizationId: string;
  footerSlot: HTMLElement | null;
  onCreated: (item: RecurringItem) => void;
  onCancel: () => void;
}): JSX.Element {
  const create = useCreateRecurringItem(organizationId);
  const [today] = useState(() => nairobiIsoDate(new Date()));
  return (
    <RecurringForm
      organizationId={organizationId}
      initialDraft={blankDraft(today)}
      submitLabel="Set up payment"
      submitting={create.isPending}
      submitError={create.isError ? create.error : null}
      footerSlot={footerSlot}
      onSubmit={(request) => create.mutate(request, { onSuccess: onCreated })}
      onCancel={onCancel}
    />
  );
}

function EditRecurring({
  organizationId,
  item,
  footerSlot,
  onDone,
}: {
  organizationId: string;
  item: RecurringItem;
  footerSlot: HTMLElement | null;
  onDone: () => void;
}): JSX.Element {
  const update = useUpdateRecurringItem(organizationId, item.id);
  return (
    <RecurringForm
      organizationId={organizationId}
      item={item}
      initialDraft={draftFromItem(item)}
      submitLabel="Save changes"
      submitting={update.isPending}
      submitError={update.isError ? update.error : null}
      footerSlot={footerSlot}
      onSubmit={(request) => update.mutate(request, { onSuccess: onDone })}
      onCancel={onDone}
    />
  );
}
