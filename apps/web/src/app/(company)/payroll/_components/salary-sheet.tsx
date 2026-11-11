"use client";

import type { JSX } from "react";
import { BanIcon, KeyRoundIcon, PencilIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { Salary } from "@expendi-business/shared";
import {
  changeSalaryAmountRequestSchema,
  createSalaryRequestSchema,
  updateSalaryRequestSchema,
} from "@expendi-business/shared";

import type { FieldErrors } from "./sheet-parts";
import type { PasskeyState } from "~/features/payment-ui";
import type { SalaryDraft } from "~/features/payroll/payroll-display";
import { textLinkClass } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { KIND_LABELS, METHOD_LABELS } from "~/features/payees/payee-display";
import { ACTIVE_PAYEES, usePayees } from "~/features/payees/payees-api";
import {
  FieldRow,
  FormField,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import {
  useChangeSalaryAmount,
  useCreateSalary,
  useEndSalary,
  useUpdateSalary,
} from "~/features/payroll/payroll-api";
import {
  blankSalaryDraft,
  canBePaidSalary,
  draftFromSalary,
  paidByInWords,
  payDayInWords,
  SALARY_STATE_LABELS,
  salaryPayees,
  toCreateSalaryRequest,
  toUpdateSalaryRequest,
  UNCONFIRMED_NUMBER,
} from "~/features/payroll/payroll-display";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatIsoDate } from "~/lib/dates";
import { formatKes, formatKesCents } from "~/lib/money";
import { errorsByField, focusFirstError } from "./sheet-parts";
import { useCategories } from "./use-categories";

type SalaryMode = "detail" | "net_pay" | "pay_day" | "end";

interface SheetState {
  /** The salary's id, or "new" while adding one. */
  readonly key: string;
  readonly mode: SalaryMode;
  readonly notice: string | null;
}

const FORM_ID = "payroll-salary-form";
const FIELD_IDS = {
  payeeId: "salary-who",
  amountKes: "salary-amount",
  payDay: "salary-pay-day",
  startsOn: "salary-starts",
  categoryId: "salary-category",
} as const;

/**
 * A salary in the side sheet (spec §6.21): admins change net pay with
 * their passkey, the pay day or category without one, or end it. With no
 * salary it adds one, then shows it.
 */
export function SalarySheet({
  organizationId,
  salaryId,
  salaries,
  index,
  total,
  onStep,
  onCreated,
  onClose,
  canAct,
  passkey,
  today,
}: {
  organizationId: string;
  /** Null while adding a salary. */
  salaryId: string | null;
  salaries: readonly Salary[];
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  onCreated: (salary: Salary) => void;
  onClose: () => void;
  canAct: boolean;
  passkey: PasskeyState;
  today: string;
}): JSX.Element | null {
  const [created, setCreated] = useState<Salary | null>(null);
  const salary = salaryId
    ? (salaries.find((candidate) => candidate.id === salaryId) ??
      (created?.id === salaryId ? created : null))
    : null;
  const key = salaryId ?? "new";
  const [state, setState] = useState<SheetState>({
    key,
    mode: "detail",
    notice: null,
  });
  const [draft, setDraft] = useState<SalaryDraft>(() =>
    blankSalaryDraft(today),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const creating = salaryId === null;
  const current: SheetState =
    state.key === key ? state : { key, mode: "detail", notice: null };
  const mode = current.mode;

  const amount = useChangeSalaryAmount(organizationId, salaryId ?? "");
  const update = useUpdateSalary(organizationId, salaryId ?? "");
  const end = useEndSalary(organizationId, salaryId ?? "");
  const create = useCreateSalary(organizationId);
  const categories = useCategories(organizationId, {
    enabled: creating || mode === "pay_day",
  });
  const payees = usePayees(organizationId, ACTIVE_PAYEES, {
    enabled: creating,
  });

  if (salaryId !== null && salary === null) return null;

  function openForm(next: SalaryMode, from: Salary) {
    amount.reset();
    update.reset();
    end.reset();
    setErrors({});
    setDraft({ ...draftFromSalary(from), amount: "" });
    setState({ key: from.id, mode: next, notice: null });
  }

  function backToDetail(notice: string | null = null) {
    setState({ key, mode: "detail", notice });
  }

  function invalid(found: FieldErrors) {
    setErrors(found);
    focusFirstError(found, FIELD_IDS);
  }

  if (creating) {
    const onPayroll = new Set(
      salaries
        .filter((candidate) => candidate.state !== "ended")
        .map((candidate) => candidate.payee.id),
    );
    const eligible = salaryPayees(payees.data ?? []).filter(
      (payee) => canBePaidSalary(payee) && !onPayroll.has(payee.id),
    );
    const loading = payees.isPending || categories.isPending;
    const failed = payees.isError || categories.isError;
    const ready = !loading && !failed && eligible.length > 0;

    const submitNew = () => {
      const request = toCreateSalaryRequest(draft);
      const parsed = createSalaryRequestSchema.safeParse(request);
      if (!parsed.success) return invalid(errorsByField(parsed.error.issues));
      setErrors({});
      create.mutate(request, {
        onSuccess: (added) => {
          setCreated(added);
          setState({ key: added.id, mode: "detail", notice: "Salary added." });
          onCreated(added);
        },
      });
    };

    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!create.isPending}
        eyebrow="Salaries"
        title="Add salary"
        stepKey="new"
        footer={
          ready ? (
            <SheetActions kind="primary">
              <Button type="submit" form={FORM_ID} disabled={create.isPending}>
                {create.isPending ? "Adding…" : "Add salary"}
              </Button>
              <Button
                variant="outline"
                disabled={create.isPending}
                onClick={onClose}
              >
                Cancel
              </Button>
            </SheetActions>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )
        }
      >
        {loading ? (
          <div aria-hidden="true" className="flex flex-col gap-4">
            <Skel width="100%" height={44} />
            <Skel width="100%" height={44} />
            <Skel width="100%" height={44} />
          </div>
        ) : failed ? (
          <Callout
            tone="error"
            action={
              <Button
                variant="outline"
                size="md"
                onClick={() => {
                  void payees.refetch();
                  void categories.refetch();
                }}
              >
                Try again
              </Button>
            }
          >
            <p>{describeApiError(payees.error ?? categories.error)}</p>
          </Callout>
        ) : eligible.length === 0 ? (
          <p className="text-muted-foreground">
            Everyone who can be paid a salary is already on payroll. Add
            employees or other personnel under{" "}
            <Link href="/payees" className={textLinkClass}>
              Payees
            </Link>
            , paid to their confirmed M-Pesa number or a bank account.
          </p>
        ) : (
          <SheetForm id={FORM_ID} label="Add salary" onSubmit={submitNew}>
            <SheetNote>
              Monthly net pay. Expendi pays what’s entered and doesn’t calculate
              tax.
            </SheetNote>
            <FormField
              id={FIELD_IDS.payeeId}
              label="Who"
              error={errors.payeeId}
            >
              <NativeSelect
                id={FIELD_IDS.payeeId}
                className="w-full"
                value={draft.payeeId ?? ""}
                aria-invalid={errors.payeeId ? true : undefined}
                onChange={(event) =>
                  setDraft({ ...draft, payeeId: event.target.value || null })
                }
              >
                <NativeSelectOption value="">
                  Choose a person
                </NativeSelectOption>
                {eligible.map((payee) => (
                  <NativeSelectOption key={payee.id} value={payee.id}>
                    {payee.name} ({KIND_LABELS[payee.kind]}
                    {payee.details
                      ? `, ${METHOD_LABELS[payee.details.method]}`
                      : ""}
                    )
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
            <FieldRow>
              <FormField
                id={FIELD_IDS.amountKes}
                label="Monthly net pay (KES)"
                error={errors.amountKes}
              >
                <Input
                  id={FIELD_IDS.amountKes}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="45,000.00"
                  value={draft.amount}
                  aria-invalid={errors.amountKes ? true : undefined}
                  onChange={(event) =>
                    setDraft({ ...draft, amount: event.target.value })
                  }
                />
              </FormField>
              <PayDayField
                draft={draft}
                onDraft={setDraft}
                error={errors.payDay}
              />
            </FieldRow>
            <FieldRow>
              <FormField
                id={FIELD_IDS.startsOn}
                label="Starts on"
                help="Leave blank to start today."
                error={errors.startsOn}
              >
                <Input
                  id={FIELD_IDS.startsOn}
                  type="date"
                  value={draft.startsOn}
                  aria-invalid={errors.startsOn ? true : undefined}
                  onChange={(event) =>
                    setDraft({ ...draft, startsOn: event.target.value })
                  }
                />
              </FormField>
              <CategoryField
                draft={draft}
                onDraft={setDraft}
                options={categories.data}
                error={errors.categoryId}
                placeholder="Choose a category"
              />
            </FieldRow>
            {errors.form ? (
              <div role="alert">
                <Callout tone="error">
                  <p>{errors.form}</p>
                </Callout>
              </div>
            ) : null}
            {create.isError ? (
              <div role="alert">
                <Callout tone="error">
                  <p>{describeApiError(create.error)}</p>
                </Callout>
              </div>
            ) : null}
          </SheetForm>
        )}
      </DetailSheet>
    );
  }

  if (salary === null) return null;
  const name = salary.payee.name;

  if (mode === "net_pay") {
    const submitAmount = () => {
      const parsed = changeSalaryAmountRequestSchema.safeParse({
        amountKes: draft.amount,
      });
      if (!parsed.success) return invalid(errorsByField(parsed.error.issues));
      if (parsed.data.amountKes.toString() === salary.amountKes) {
        return invalid({ amountKes: "That’s already their net pay." });
      }
      setErrors({});
      amount.mutate(draft.amount.trim(), {
        onSuccess: (outcome) => {
          if (outcome.status !== "approved") return;
          backToDetail(
            `Saved. Net pay is now KES ${formatKes(outcome.result.amountKes)}.`,
          );
        },
      });
    };
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!amount.isPending}
        eyebrow={name}
        title="Change net pay"
        stepKey={`${salary.id}-net-pay`}
        footer={
          <SheetActions kind="primary">
            <Button type="submit" form={FORM_ID} disabled={amount.isPending}>
              {amount.isPending ? (
                "Waiting for your passkey…"
              ) : (
                <>
                  <KeyRoundIcon aria-hidden="true" />
                  Change with passkey
                </>
              )}
            </Button>
            <Button
              variant="outline"
              disabled={amount.isPending}
              onClick={() => backToDetail()}
            >
              Back
            </Button>
          </SheetActions>
        }
      >
        <SheetForm id={FORM_ID} label="Change net pay" onSubmit={submitAmount}>
          <FormField
            id={FIELD_IDS.amountKes}
            label="New monthly net pay (KES)"
            error={errors.amountKes}
          >
            <Input
              id={FIELD_IDS.amountKes}
              inputMode="decimal"
              autoComplete="off"
              placeholder={formatKesCents(salary.amountKes)}
              value={draft.amount}
              disabled={amount.isPending}
              aria-invalid={errors.amountKes ? true : undefined}
              onChange={(event) =>
                setDraft({ ...draft, amount: event.target.value })
              }
            />
          </FormField>
          <SheetNote>
            You confirm it with your passkey, and every admin gets an email. It
            applies from the next payroll run.
          </SheetNote>
          {amount.data?.status === "cancelled" ? (
            <SheetNote>Cancelled. Nothing changed.</SheetNote>
          ) : null}
          {amount.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApprovalError(amount.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      </DetailSheet>
    );
  }

  if (mode === "pay_day") {
    const submitPayDay = () => {
      const request = toUpdateSalaryRequest(salary, draft);
      const parsed = updateSalaryRequestSchema.safeParse(request);
      if (!parsed.success) {
        return invalid(
          errorsByField(parsed.error.issues, { form: "categoryId" }),
        );
      }
      setErrors({});
      update.mutate(request, { onSuccess: () => backToDetail("Saved.") });
    };
    const options = categories.data ?? [];
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!update.isPending}
        eyebrow={name}
        title="Pay day and category"
        stepKey={`${salary.id}-pay-day`}
        footer={
          <SheetActions kind="primary">
            <Button type="submit" form={FORM_ID} disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              disabled={update.isPending}
              onClick={() => backToDetail()}
            >
              Back
            </Button>
          </SheetActions>
        }
      >
        <SheetForm
          id={FORM_ID}
          label="Change pay day or category"
          onSubmit={submitPayDay}
        >
          <FieldRow>
            <PayDayField
              draft={draft}
              onDraft={setDraft}
              error={errors.payDay}
            />
            <CategoryField
              draft={draft}
              onDraft={setDraft}
              options={
                options.some((option) => option.id === salary.category.id)
                  ? options
                  : [salary.category, ...options]
              }
              error={
                errors.categoryId ??
                (categories.isError
                  ? describeApiError(categories.error)
                  : undefined)
              }
            />
          </FieldRow>
          <SheetNote>
            A new pay day applies from the next pay date not yet drafted.
          </SheetNote>
          {update.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(update.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      </DetailSheet>
    );
  }

  if (mode === "end") {
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!end.isPending}
        eyebrow={name}
        title={`End ${name}’s salary?`}
        stepKey={`${salary.id}-end`}
        footer={
          <SheetActions kind="primary">
            <Button
              disabled={end.isPending}
              onClick={() =>
                end.mutate(undefined, {
                  onSuccess: () => backToDetail("Salary ended."),
                })
              }
            >
              {end.isPending ? "Ending…" : "End salary"}
            </Button>
            <Button
              variant="outline"
              disabled={end.isPending}
              onClick={() => backToDetail()}
            >
              Keep it
            </Button>
          </SheetActions>
        }
      >
        <Callout tone="warn" icon={BanIcon}>
          <p>
            They won’t be in payroll runs drafted from now on. Payments already
            made stay in the history. Ending is final.
          </p>
        </Callout>
        {end.isError ? (
          <div role="alert">
            <Callout tone="error">
              <p>{describeApiError(end.error)}</p>
            </Callout>
          </div>
        ) : null}
      </DetailSheet>
    );
  }

  const badge = SALARY_STATE_LABELS[salary.state];
  const canPay = passkey === "ready";
  const position = <SheetPosition index={index} total={total} />;

  return (
    <DetailSheet
      open
      onClose={onClose}
      eyebrow="Salary"
      title={name}
      stepKey={salary.id}
      headerExtra={
        <>
          <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
            <Money amount={salary.amountKes} currency="KES" />
            <span className="text-sm leading-5 tracking-normal text-muted-foreground">
              {" "}
              a month
            </span>
          </p>
          <StatusBadge tone={badge.tone} className="mt-2">
            {badge.label}
          </StatusBadge>
        </>
      }
      stepper={{
        index,
        total,
        onStep,
        previousLabel: "Previous salary",
        nextLabel: "Next salary",
      }}
      footer={
        !canAct ? (
          <>
            <ReadOnlyNote>View only. Only admins change salaries.</ReadOnlyNote>
            {position}
          </>
        ) : salary.state === "ended" ? (
          position
        ) : (
          <>
            <SheetActions kind="primary">
              {canPay ? (
                <Button onClick={() => openForm("net_pay", salary)}>
                  <PencilIcon aria-hidden="true" />
                  Change net pay
                </Button>
              ) : null}
              <Button
                variant={canPay ? "outline" : "default"}
                onClick={() => openForm("pay_day", salary)}
              >
                Pay day and category
              </Button>
            </SheetActions>
            <SheetActions kind="secondary">
              <Button
                variant="danger"
                size="md"
                onClick={() => openForm("end", salary)}
              >
                End salary
              </Button>
            </SheetActions>
            {passkey === "missing" ? (
              <ReadOnlyNote icon={KeyRoundIcon} wide>
                Changing net pay needs your approval passkey.
              </ReadOnlyNote>
            ) : null}
          </>
        )
      }
    >
      {current.notice ? (
        <div role="status">
          <Callout tone="success">
            <p>{current.notice}</p>
          </Callout>
        </div>
      ) : null}
      <DetailList>
        <DetailItem label="Pay day">{payDayInWords(salary.payDay)}</DetailItem>
        {salary.nextPayDate ? (
          <DetailItem label="Next pay date">
            {formatIsoDate(salary.nextPayDate)}
          </DetailItem>
        ) : null}
        <DetailItem label="Started">
          {formatIsoDate(salary.startsOn)}
        </DetailItem>
        {salary.endsOn ? (
          <DetailItem label="Ends">{formatIsoDate(salary.endsOn)}</DetailItem>
        ) : null}
        <DetailItem label="Category">{salary.category.name}</DetailItem>
        <DetailItem
          label="Paid by"
          sub={
            salary.payee.payoutPhoneConfirmed === false ? (
              <span className="text-warn-700">{UNCONFIRMED_NUMBER}</span>
            ) : null
          }
        >
          {paidByInWords(salary.payee)}
        </DetailItem>
      </DetailList>
    </DetailSheet>
  );
}

function PayDayField({
  draft,
  onDraft,
  error,
}: {
  draft: SalaryDraft;
  onDraft: (draft: SalaryDraft) => void;
  error: string | undefined;
}): JSX.Element {
  return (
    <FormField id={FIELD_IDS.payDay} label="Pay day (1 to 31)" error={error}>
      <Input
        id={FIELD_IDS.payDay}
        inputMode="numeric"
        maxLength={2}
        value={draft.payDay}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onDraft({ ...draft, payDay: event.target.value })}
      />
    </FormField>
  );
}

function CategoryField({
  draft,
  onDraft,
  options,
  error,
  placeholder,
}: {
  draft: SalaryDraft;
  onDraft: (draft: SalaryDraft) => void;
  options: readonly { id: string; name: string }[];
  error: string | undefined;
  placeholder?: string;
}): JSX.Element {
  return (
    <FormField id={FIELD_IDS.categoryId} label="Category" error={error}>
      <NativeSelect
        id={FIELD_IDS.categoryId}
        className="w-full"
        value={draft.categoryId ?? ""}
        aria-invalid={error ? true : undefined}
        onChange={(event) =>
          onDraft({ ...draft, categoryId: event.target.value || null })
        }
      >
        {placeholder ? (
          <NativeSelectOption value="">{placeholder}</NativeSelectOption>
        ) : null}
        {options.map((category) => (
          <NativeSelectOption key={category.id} value={category.id}>
            {category.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FormField>
  );
}
