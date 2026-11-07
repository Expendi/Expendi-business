"use client";

import type { LucideIcon } from "lucide-react";
import type { FormEvent, JSX } from "react";
import {
  ArchiveIcon,
  BanknoteIcon,
  CreditCardIcon,
  LandmarkIcon,
  PlusIcon,
  SmartphoneIcon,
  WalletIcon,
} from "lucide-react";
import { useId, useState } from "react";

import type {
  PaidFromAccount,
  PaidFromAccountKind,
} from "@expendi-business/shared";
import {
  createPaidFromAccountRequestSchema,
  PAID_FROM_ACCOUNT_KINDS,
  PAID_FROM_ACCOUNT_NAME_MAX_LENGTH,
  paidFromAccountKindSchema,
} from "@expendi-business/shared";

import {
  Callout,
  DetailSheet,
  SheetActions,
} from "~/components/data/detail-sheet";
import { KindTabs } from "~/components/data/kind-tabs";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { describeApiError } from "~/lib/api";
import {
  useArchivedPaidFromAccounts,
  useChangePaidFromAccount,
  usePaidFromAccounts,
} from "./settings-api";
import {
  PanelEmpty,
  PanelError,
  PanelSkeleton,
  RowButton,
  sameName,
  SettingsList,
  SettingsPanel,
  SettingsRow,
  tidy,
  useSheetForm,
} from "./settings-panel";

export const ACCOUNT_KIND_LABELS: Record<PaidFromAccountKind, string> = {
  bank: "Bank account",
  card: "Card",
  mobile_money: "Mobile money",
  cash: "Cash",
  other: "Other",
};

const KIND_ICONS: Record<PaidFromAccountKind, LucideIcon> = {
  bank: LandmarkIcon,
  card: CreditCardIcon,
  mobile_money: SmartphoneIcon,
  cash: BanknoteIcon,
  other: WalletIcon,
};

type AccountTab = "active" | "archived";

const byName = (a: PaidFromAccount, b: PaidFromAccount) =>
  a.name.localeCompare(b.name);

/**
 * The accounts company spending was paid from outside Expendi (spec
 * §6.23), e.g. the bank account or the founder's card. Admins add, edit and
 * archive them; archived ones stay on old spending.
 */
export function PaidFromAccounts({
  organizationId,
  canAct,
  openId,
  onOpen,
}: {
  organizationId: string;
  canAct: boolean;
  /** The account whose form is open (`?account=`), admins only. */
  openId: string | null;
  onOpen: (accountId: string | null) => void;
}): JSX.Element {
  const active = usePaidFromAccounts(organizationId);
  const archived = useArchivedPaidFromAccounts(organizationId);
  const [tab, setTab] = useState<AccountTab>("active");
  const [adding, setAdding] = useState(false);

  const inUse = [...(active.data ?? [])].sort(byName);
  const old = [...(archived.data ?? [])].sort(byName);
  const editing = canAct
    ? inUse.find((account) => account.id === openId)
    : undefined;
  const list = tab === "archived" ? old : inUse;

  const addButton = (variant: "outline" | "default") => (
    <Button
      variant={variant}
      size="md"
      aria-haspopup="dialog"
      onClick={() => setAdding(true)}
    >
      <PlusIcon aria-hidden="true" />
      Add an account
    </Button>
  );

  return (
    <SettingsPanel
      id="accounts"
      title="Paid-from accounts"
      sub="Company spending says which of these it was paid from, e.g. the bank account or the founder’s card."
      actions={canAct && active.isSuccess ? addButton("outline") : null}
      busy={active.isPending}
    >
      {active.isPending ? (
        <PanelSkeleton lines={3} />
      ) : active.isError ? (
        <PanelError
          title="Paid-from accounts didn't load"
          message={describeApiError(active.error)}
          onRetry={() => void active.refetch()}
        />
      ) : (
        <>
          <KindTabs
            label="Paid-from accounts"
            tabs={[
              { value: "active", label: "In use", count: inUse.length },
              {
                value: "archived",
                label: "Archived",
                count: archived.isSuccess ? old.length : undefined,
              },
            ]}
            value={tab}
            onChange={setTab}
            controls="accounts-list"
          />
          {tab === "archived" && archived.isError ? (
            <PanelError
              title="Archived accounts didn't load"
              message={describeApiError(archived.error)}
              onRetry={() => void archived.refetch()}
            />
          ) : list.length === 0 ? (
            <div id="accounts-list" role="tabpanel">
              <PanelEmpty
                action={
                  tab === "active" && canAct ? addButton("default") : null
                }
              >
                {tab === "archived"
                  ? "No archived accounts."
                  : "No accounts yet."}
              </PanelEmpty>
            </div>
          ) : (
            <div id="accounts-list" role="tabpanel">
              <SettingsList
                label={
                  tab === "archived"
                    ? "Archived accounts"
                    : "Paid-from accounts in use"
                }
              >
                {list.map((account) => {
                  const editable = canAct && tab === "active";
                  const Icon = KIND_ICONS[account.kind];
                  return (
                    <SettingsRow
                      key={account.id}
                      open={editable && account.id === openId}
                      onOpen={editable ? () => onOpen(account.id) : undefined}
                    >
                      <span
                        aria-hidden="true"
                        className="inline-flex size-8 flex-none items-center justify-center rounded-control border border-gray-200 bg-surface text-gray-600"
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-(--w-name)">
                          {account.name}
                        </span>
                        <span className="block truncate text-xs leading-4 text-gray-500">
                          {ACCOUNT_KIND_LABELS[account.kind]}
                        </span>
                      </span>
                      {editable ? (
                        <RowButton
                          label={`Edit ${account.name}`}
                          aria-haspopup="dialog"
                          onClick={() => onOpen(account.id)}
                        >
                          Edit
                        </RowButton>
                      ) : null}
                    </SettingsRow>
                  );
                })}
              </SettingsList>
            </div>
          )}
        </>
      )}
      {canAct ? (
        <AccountSheet
          organizationId={organizationId}
          open={adding || editing !== undefined}
          account={editing ?? null}
          existing={[...inUse, ...old]}
          onClose={() => {
            setAdding(false);
            onOpen(null);
          }}
          onAdded={() => setTab("active")}
        />
      ) : null}
    </SettingsPanel>
  );
}

interface AccountForm {
  readonly step: "form" | "archive";
  readonly name: string;
  readonly kind: PaidFromAccountKind;
  readonly nameError: string | null;
}

const initialForm = (account: PaidFromAccount | null): AccountForm => ({
  step: "form",
  name: account?.name ?? "",
  kind: account?.kind ?? "bank",
  nameError: null,
});

function AccountSheet({
  organizationId,
  open,
  account,
  existing,
  onClose,
  onAdded,
}: {
  organizationId: string;
  open: boolean;
  /** Null to add one. */
  account: PaidFromAccount | null;
  existing: readonly PaidFromAccount[];
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const change = useChangePaidFromAccount(organizationId);
  const { subject, form, setForm } = useSheetForm(open, account, initialForm);
  const nameId = useId();
  const kindId = useId();
  const unchanged =
    subject !== null &&
    tidy(form.name) === subject.name &&
    form.kind === subject.kind;

  function close() {
    change.reset();
    onClose();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = createPaidFromAccountRequestSchema.shape.name.safeParse(
      form.name,
    );
    const name = parsed.success ? tidy(parsed.data) : "";
    const problem = !parsed.success
      ? (parsed.error.issues[0]?.message ?? "Check the name.")
      : existing.some(
            (other) => other.id !== subject?.id && sameName(other.name, name),
          )
        ? `There's already an account called ${name}.`
        : null;
    if (problem) {
      setForm((now) => ({ ...now, nameError: problem }));
      document.getElementById(nameId)?.focus();
      return;
    }
    if (subject === null) {
      change.mutate(
        { kind: "create", fields: { name, kind: form.kind } },
        {
          onSuccess: () => {
            onAdded();
            close();
          },
        },
      );
      return;
    }
    change.mutate(
      {
        kind: "update",
        accountId: subject.id,
        changes: {
          ...(name === subject.name ? {} : { name }),
          ...(form.kind === subject.kind ? {} : { kind: form.kind }),
        },
      },
      { onSuccess: close },
    );
  }

  const failed = change.isError ? (
    <div role="alert">
      <Callout tone="error">
        <p>{describeApiError(change.error)}</p>
      </Callout>
    </div>
  ) : null;

  if (subject !== null && form.step === "archive") {
    return (
      <DetailSheet
        open={open}
        onClose={close}
        dismissible={!change.isPending}
        eyebrow={subject.name}
        title="Archive this account?"
        stepKey={`${subject.id}-archive`}
        footer={
          <>
            <Button
              disabled={change.isPending}
              onClick={() =>
                change.mutate(
                  { kind: "archive", accountId: subject.id },
                  { onSuccess: close },
                )
              }
            >
              {change.isPending ? "Archiving…" : "Archive"}
            </Button>
            <Button
              variant="outline"
              disabled={change.isPending}
              onClick={() => {
                change.reset();
                setForm((now) => ({ ...now, step: "form" }));
              }}
            >
              Keep it
            </Button>
          </>
        }
      >
        {failed}
        <Callout tone="neutral" icon={ArchiveIcon}>
          <p>
            {subject.name} can’t be picked for new spending. Spending already
            recorded keeps it.
          </p>
        </Callout>
      </DetailSheet>
    );
  }

  return (
    <DetailSheet
      open={open}
      onClose={close}
      dismissible={!change.isPending}
      eyebrow={subject?.name ?? "Paid-from accounts"}
      title={subject ? "Edit account" : "Add an account"}
      stepKey={subject?.id ?? "new"}
      footer={
        <>
          <Button
            type="submit"
            form="account-form"
            disabled={change.isPending || unchanged}
          >
            {change.isPending
              ? subject
                ? "Saving…"
                : "Adding…"
              : subject
                ? "Save"
                : "Add account"}
          </Button>
          <Button variant="outline" disabled={change.isPending} onClick={close}>
            Cancel
          </Button>
          {subject ? (
            <SheetActions kind="secondary">
              <Button
                variant="ghost"
                size="md"
                disabled={change.isPending}
                onClick={() => {
                  change.reset();
                  setForm((now) => ({ ...now, step: "archive" }));
                }}
              >
                <ArchiveIcon aria-hidden="true" />
                Archive
              </Button>
            </SheetActions>
          ) : null}
        </>
      }
    >
      <form
        id="account-form"
        aria-label={subject ? `Edit ${subject.name}` : "Add an account"}
        noValidate
        onSubmit={onSubmit}
        className="flex flex-col gap-[18px]"
      >
        {failed}
        <Field>
          <FieldLabel htmlFor={nameId}>Account name</FieldLabel>
          <Input
            id={nameId}
            value={form.name}
            maxLength={PAID_FROM_ACCOUNT_NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder="KCB current account"
            aria-invalid={form.nameError ? true : undefined}
            onChange={(event) => {
              const name = event.target.value;
              setForm((now) => ({ ...now, name, nameError: null }));
            }}
          />
          <FieldError>{form.nameError}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={kindId}>Kind</FieldLabel>
          <NativeSelect
            id={kindId}
            className="w-full"
            value={form.kind}
            onChange={(event) => {
              const kind = paidFromAccountKindSchema.safeParse(
                event.target.value,
              );
              if (kind.success) {
                setForm((now) => ({ ...now, kind: kind.data }));
              }
            }}
          >
            {PAID_FROM_ACCOUNT_KINDS.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {ACCOUNT_KIND_LABELS[kind]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            So your accountant can match it to the right account in Zoho Books.
          </FieldDescription>
        </Field>
      </form>
    </DetailSheet>
  );
}
