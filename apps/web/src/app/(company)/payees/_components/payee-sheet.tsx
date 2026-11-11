"use client";

import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BanknoteIcon,
  FileTextIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type {
  CreatePayeeRequest,
  Member,
  Payee,
  PayeeChangeChallenge,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import {
  createPayeeRequestSchema,
  PAYEE_KINDS,
  PAYEE_NAME_MAX_LENGTH,
  updatePayeeRequestSchema,
} from "@expendi-business/shared";

import type {
  DetailField,
  DetailFieldErrors,
  DetailValues,
} from "~/features/payees/payee-fields";
import type { PayeeChangeRequest } from "~/features/payees/payees-api";
import type { PasskeyState } from "~/features/payment-ui";
import { textLinkClass } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SectionLabel,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { useAuth } from "~/contexts/auth-context";
import {
  CHANGE_WARNING,
  detailRows,
  isPerson,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  METHOD_DESCRIPTIONS,
  RECENTLY_CHANGED_LABEL,
} from "~/features/payees/payee-display";
import {
  changeDetailValue,
  detailsToValues,
  EMPTY_DETAIL_VALUES,
  methodsForKind,
  validateDetails,
} from "~/features/payees/payee-fields";
import {
  useArchivePayee,
  useBankName,
  useConfirmPayeeChange,
  usePayee,
  useRequestPayeeChange,
  useRestorePayee,
  useUpdatePayee,
} from "~/features/payees/payees-api";
import {
  FormField,
  PasskeySetupCallout,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { queryKeys } from "~/lib/query-keys";
import { detailFieldId, PayeeDetailsFields } from "./payee-details-fields";
import { PayeeReview } from "./payee-review";

type Mode = "detail" | "details" | "edit" | "archive" | "restore";

interface SheetState {
  /** The payee's id, or "new" while adding one. */
  readonly key: string;
  readonly mode: Mode;
  readonly notice: string | null;
}

interface DetailsDraft {
  readonly kind: PayeeKind;
  readonly membershipId: string;
  readonly name: string;
  readonly method: PayeeMethod;
  readonly values: DetailValues;
}

interface DraftErrors {
  readonly name?: string;
  readonly membershipId?: string;
  readonly details: DetailFieldErrors;
}

interface PendingReview {
  readonly key: string;
  readonly request: PayeeChangeRequest;
  readonly challenge: PayeeChangeChallenge;
  readonly memberName: string | null;
  readonly payoutPhoneConfirmed: boolean | null;
}

const FORM_ID = "payee-form";
const NAME_ID = "payee-name";
const KIND_ID = "payee-kind";
const MEMBER_ID = "payee-member";
const NO_ERRORS: DraftErrors = { details: {} };
const OTHER_KINDS = PAYEE_KINDS.filter((kind) => kind !== "employee");

const NEW_DRAFT: DetailsDraft = {
  kind: "supplier",
  membershipId: "",
  name: "",
  method: "mpesa_phone",
  values: EMPTY_DETAIL_VALUES,
};

export function memberName(member: Pick<Member, "name" | "email">): string {
  return member.name ?? member.email;
}

/** The method a payee's form starts on: theirs, or the first one their kind allows. */
function startingMethod(
  kind: PayeeKind,
  current: PayeeMethod | null,
): PayeeMethod {
  const allowed = methodsForKind(kind);
  return current && allowed.includes(current)
    ? current
    : (allowed[0] ?? "outside");
}

function focusFirst(errors: DraftErrors, fields: readonly DetailField[]) {
  const field = errors.membershipId
    ? MEMBER_ID
    : errors.name
      ? NAME_ID
      : fields.find((name) => errors.details[name]);
  if (!field) return;
  const id =
    field === MEMBER_ID || field === NAME_ID ? field : detailFieldId(field);
  document.getElementById(id)?.focus();
}

/**
 * A payee in the side sheet (spec §6.19): its details, and for admins the
 * payment-details change (reviewed, then confirmed with their passkey),
 * name and kind, archive and restore. With no payee it adds one, then
 * shows it.
 */
export function PayeeSheet({
  organizationId,
  payeeId,
  listed,
  activePayees,
  index,
  total,
  onStep,
  onShow,
  onClose,
  canAct,
  passkey,
}: {
  organizationId: string;
  /** Null while adding a payee. */
  payeeId: string | null;
  /** The payee as the list has it, shown until its own read arrives. */
  listed: Payee | null;
  /** Who's already a payee, so each team member is added once. */
  activePayees: readonly Payee[];
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  /** Shows this payee in the list and the URL, e.g. once added or archived. */
  onShow: (payee: Payee) => void;
  onClose: () => void;
  canAct: boolean;
  passkey: PasskeyState;
}): JSX.Element {
  const key = payeeId ?? "new";
  const creating = payeeId === null;
  const detail = usePayee(organizationId, payeeId ?? "", {
    enabled: payeeId !== null,
  });
  const payee = payeeId ? (detail.data ?? listed) : null;
  const [state, setState] = useState<SheetState>({
    key,
    mode: "detail",
    notice: null,
  });
  const [draft, setDraft] = useState<DetailsDraft>(NEW_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>(NO_ERRORS);
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [edit, setEdit] = useState({ name: "", kind: NEW_DRAFT.kind });
  const [editError, setEditError] = useState<string | null>(null);

  const request = useRequestPayeeChange(organizationId);
  const confirm = useConfirmPayeeChange(organizationId);
  const renew = useRequestPayeeChange(organizationId);
  const update = useUpdatePayee(organizationId, payeeId ?? "");
  const archive = useArchivePayee(organizationId, payeeId ?? "");
  const restore = useRestorePayee(organizationId, payeeId ?? "");
  const bankName = useBankName(organizationId, payee?.details ?? null);
  const { api } = useAuth();
  const members = useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: () => api.listMembers(organizationId),
    enabled: creating && draft.kind === "employee",
  });

  const current: SheetState =
    state.key === key ? state : { key, mode: "detail", notice: null };
  const review = pending?.key === key ? pending : null;
  const busy =
    request.isPending ||
    confirm.isPending ||
    renew.isPending ||
    update.isPending ||
    archive.isPending ||
    restore.isPending;

  function setMode(mode: Mode, notice: string | null = null) {
    setState({ key, mode, notice });
  }

  function resetChange() {
    request.reset();
    confirm.reset();
    renew.reset();
    setPending(null);
    setErrors(NO_ERRORS);
  }

  function finished(saved: Payee) {
    resetChange();
    if (creating) {
      setState({ key: saved.id, mode: "detail", notice: "Payee added." });
      onShow(saved);
      return;
    }
    setMode(
      "detail",
      `Payment details saved. Every admin was emailed. Paying ${saved.name} in the next 24 hours needs a second confirmation.`,
    );
  }

  function askToConfirm(
    change: PayeeChangeRequest,
    challenge: PayeeChangeChallenge,
    who: { name: string | null; confirmed: boolean | null },
  ) {
    setPending({
      key,
      request: change,
      challenge,
      memberName: who.name,
      payoutPhoneConfirmed: who.confirmed,
    });
  }

  function submitNew() {
    const employee = draft.kind === "employee";
    const parsedName = createPayeeRequestSchema.shape.name.safeParse(
      draft.name,
    );
    const details = validateDetails(draft.method, draft.kind, draft.values);
    const found: DraftErrors = {
      name: parsedName.error?.issues[0]?.message,
      membershipId:
        employee && draft.membershipId === ""
          ? "Choose the employee."
          : undefined,
      details: details.ok ? {} : details.errors,
    };
    if (!parsedName.success || !details.ok || found.membershipId) {
      setErrors(found);
      focusFirst(found, Object.keys(found.details) as DetailField[]);
      return;
    }
    setErrors(NO_ERRORS);
    const payeeRequest: CreatePayeeRequest = employee
      ? {
          kind: draft.kind,
          name: parsedName.data,
          membershipId: draft.membershipId,
          details: details.details,
        }
      : { kind: draft.kind, name: parsedName.data, details: details.details };
    const change: PayeeChangeRequest = {
      action: "create",
      payee: payeeRequest,
    };
    const member = members.data?.find(
      (candidate) => candidate.id === draft.membershipId,
    );
    request.mutate(change, {
      onSuccess: (response) => {
        if (response.status === "created") finished(response.payee);
        else {
          askToConfirm(change, response, {
            name: employee && member ? memberName(member) : null,
            confirmed: employee ? (member?.payoutPhoneConfirmed ?? null) : null,
          });
        }
      },
    });
  }

  function submitDetails(target: Payee) {
    const details = validateDetails(draft.method, target.kind, draft.values);
    if (!details.ok) {
      const found = { details: details.errors };
      setErrors(found);
      focusFirst(found, Object.keys(details.errors) as DetailField[]);
      return;
    }
    setErrors(NO_ERRORS);
    const change: PayeeChangeRequest = {
      action: "change_details",
      payeeId: target.id,
      details: details.details,
    };
    request.mutate(change, {
      onSuccess: (response) => {
        if (response.status === "confirmation_required") {
          askToConfirm(change, response, {
            name: null,
            confirmed: target.payoutPhoneConfirmed,
          });
        }
      },
    });
  }

  function confirmReview(pendingReview: PendingReview) {
    confirm.mutate(pendingReview.challenge, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") finished(outcome.result);
      },
    });
  }

  function startAgain(pendingReview: PendingReview) {
    renew.mutate(pendingReview.request, {
      onSuccess: (response) => {
        if (response.status === "created") {
          finished(response.payee);
          return;
        }
        confirm.reset();
        setPending({ ...pendingReview, challenge: response });
      },
    });
  }

  function reviewSheet(
    shown: PendingReview,
    eyebrow: string,
    title: string,
    target: Payee | null,
  ) {
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!busy}
        eyebrow={eyebrow}
        title={title}
        stepKey={`${key}-review`}
        footer={
          <SheetActions kind="primary">
            {confirm.isError ? (
              <Button disabled={busy} onClick={() => startAgain(shown)}>
                {renew.isPending ? "Starting again…" : "Start again"}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => confirmReview(shown)}>
                {confirm.isPending ? (
                  "Waiting for your passkey…"
                ) : (
                  <>
                    <KeyRoundIcon aria-hidden="true" />
                    Confirm with passkey
                  </>
                )}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                confirm.reset();
                renew.reset();
                setPending(null);
              }}
            >
              Edit
            </Button>
          </SheetActions>
        }
      >
        <PayeeReview
          organizationId={organizationId}
          challenge={shown.challenge}
          currentPayee={target}
          memberName={shown.memberName}
          payoutPhoneConfirmed={shown.payoutPhoneConfirmed}
          cancelled={confirm.data?.status === "cancelled"}
          error={
            confirm.isError
              ? describeApprovalError(confirm.error)
              : renew.isError
                ? describeApiError(renew.error)
                : null
          }
        />
      </DetailSheet>
    );
  }

  function gateSheet(eyebrow: string, title: string, back: ReactNode) {
    return (
      <DetailSheet
        open
        onClose={onClose}
        eyebrow={eyebrow}
        title={title}
        stepKey={`${key}-gate`}
        footer={back}
      >
        {passkey === "missing" ? (
          <PasskeySetupCallout />
        ) : (
          <Skel width="100%" height={72} />
        )}
      </DetailSheet>
    );
  }

  const submitFooter = (
    label: string,
    busyLabel: string,
    cancel: ReactNode,
  ) => (
    <SheetActions kind="primary">
      <Button type="submit" form={FORM_ID} disabled={busy}>
        {busy ? busyLabel : label}
      </Button>
      {cancel}
    </SheetActions>
  );

  if (creating) {
    if (passkey !== "ready") {
      return gateSheet(
        "Payees",
        "Add a payee",
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>,
      );
    }
    if (review) {
      return reviewSheet(review, "Payees", "Review the new payee", null);
    }
    const employee = draft.kind === "employee";
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!busy}
        eyebrow="Payees"
        title="Add a payee"
        stepKey="new"
        footer={submitFooter(
          draft.method === "outside" ? "Add payee" : "Review",
          "Checking…",
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>,
        )}
      >
        <SheetForm id={FORM_ID} label="Add a payee" onSubmit={submitNew}>
          <FormField
            id={KIND_ID}
            label="Who is this payee?"
            help={KIND_DESCRIPTIONS[draft.kind]}
          >
            <NativeSelect
              id={KIND_ID}
              className="w-full"
              value={draft.kind}
              disabled={busy}
              onChange={(event) => {
                const next = PAYEE_KINDS.find(
                  (candidate) => candidate === event.target.value,
                );
                if (!next) return;
                request.reset();
                setDraft({
                  ...draft,
                  kind: next,
                  membershipId: next === "employee" ? draft.membershipId : "",
                  method: startingMethod(next, draft.method),
                });
              }}
            >
              {PAYEE_KINDS.map((candidate) => (
                <NativeSelectOption key={candidate} value={candidate}>
                  {KIND_LABELS[candidate]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          {employee ? (
            <EmployeePicker
              members={members.data ?? null}
              membersError={members.isError ? members.error : null}
              activePayees={activePayees}
              membershipId={draft.membershipId}
              error={errors.membershipId}
              disabled={busy}
              onChoose={(chosen) => {
                request.reset();
                setDraft({
                  ...draft,
                  membershipId: chosen.id,
                  name:
                    draft.name.trim() === "" && chosen.name
                      ? chosen.name
                      : draft.name,
                  values:
                    draft.values.accountName.trim() === "" && chosen.name
                      ? { ...draft.values, accountName: chosen.name }
                      : draft.values,
                });
              }}
            />
          ) : null}
          <FormField id={NAME_ID} label="Payee name" error={errors.name}>
            <Input
              id={NAME_ID}
              type="text"
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              placeholder={employee ? "Their full name" : "e.g. Kenya Power"}
              maxLength={PAYEE_NAME_MAX_LENGTH}
              disabled={busy}
              autoComplete="off"
              aria-invalid={errors.name ? true : undefined}
            />
          </FormField>
          <PayeeDetailsFields
            organizationId={organizationId}
            kind={draft.kind}
            method={draft.method}
            onMethodChange={(next) => {
              request.reset();
              setDraft({ ...draft, method: next });
            }}
            values={draft.values}
            onValueChange={(field, value) =>
              setDraft({
                ...draft,
                values: changeDetailValue(draft.values, field, value),
              })
            }
            errors={errors.details}
            disabled={busy}
          />
          {request.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(request.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      </DetailSheet>
    );
  }

  if (!payee) {
    return (
      <DetailSheet
        open
        onClose={onClose}
        title={detail.isError ? "Payee didn't load" : "Loading…"}
      >
        {detail.isError ? (
          <Callout
            tone="error"
            action={
              <Button
                variant="outline"
                size="md"
                onClick={() => void detail.refetch()}
              >
                Try again
              </Button>
            }
          >
            <p>{describeApiError(detail.error)}</p>
          </Callout>
        ) : (
          <Skel width="100%" height={120} />
        )}
      </DetailSheet>
    );
  }

  const back = (
    <Button variant="outline" disabled={busy} onClick={() => setMode("detail")}>
      Back
    </Button>
  );
  const detailsTitle = payee.details
    ? "Change payment details"
    : "Add payment details";

  if (current.mode === "details") {
    if (passkey !== "ready") return gateSheet(payee.name, detailsTitle, back);
    if (review) {
      return reviewSheet(
        review,
        payee.name,
        "Review the new payment details",
        payee,
      );
    }
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!busy}
        eyebrow={payee.name}
        title={detailsTitle}
        stepKey={`${payee.id}-details`}
        footer={submitFooter(
          "Review",
          "Checking…",
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setMode("detail")}
          >
            Cancel
          </Button>,
        )}
      >
        <SheetForm
          id={FORM_ID}
          label="Payment details"
          onSubmit={() => submitDetails(payee)}
        >
          <Callout tone="warn" icon={ShieldAlertIcon}>
            <p>{CHANGE_WARNING}</p>
          </Callout>
          <PayeeDetailsFields
            organizationId={organizationId}
            kind={payee.kind}
            method={draft.method}
            onMethodChange={(next) => {
              request.reset();
              setDraft({ ...draft, method: next });
            }}
            values={draft.values}
            onValueChange={(field, value) =>
              setDraft({
                ...draft,
                values: changeDetailValue(draft.values, field, value),
              })
            }
            errors={errors.details}
            disabled={busy}
          />
          {request.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(request.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      </DetailSheet>
    );
  }

  if (current.mode === "edit") {
    const name = edit.name;
    const nameChanged = name.trim() !== payee.name;
    const kindChanged = edit.kind !== payee.kind;
    const submitEdit = () => {
      const parsed = updatePayeeRequestSchema.safeParse({
        ...(nameChanged ? { name } : {}),
        ...(kindChanged ? { kind: edit.kind } : {}),
      });
      if (!parsed.success) {
        setEditError(
          parsed.error.issues[0]?.message ?? "Check the name and kind.",
        );
        document.getElementById(NAME_ID)?.focus();
        return;
      }
      setEditError(null);
      update.mutate(parsed.data, {
        onSuccess: () => setMode("detail", "Changes saved."),
      });
    };
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!busy}
        eyebrow={payee.name}
        title="Name and kind"
        stepKey={`${payee.id}-edit`}
        footer={
          <SheetActions kind="primary">
            <Button
              type="submit"
              form={FORM_ID}
              disabled={busy || (!nameChanged && !kindChanged)}
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setMode("detail")}
            >
              Cancel
            </Button>
          </SheetActions>
        }
      >
        <SheetForm id={FORM_ID} label="Name and kind" onSubmit={submitEdit}>
          <FormField id={NAME_ID} label="Payee name" error={editError}>
            <Input
              id={NAME_ID}
              type="text"
              value={name}
              onChange={(event) => {
                setEdit({ ...edit, name: event.target.value });
                setEditError(null);
                update.reset();
              }}
              maxLength={PAYEE_NAME_MAX_LENGTH}
              disabled={busy}
              autoComplete="off"
              aria-invalid={editError ? true : undefined}
            />
          </FormField>
          {payee.kind === "employee" ? (
            <SheetNote>
              An employee payee stays an employee. To pay someone else, archive
              this payee and add a new one.
            </SheetNote>
          ) : (
            <FormField
              id={KIND_ID}
              label="Kind"
              help={KIND_DESCRIPTIONS[edit.kind]}
            >
              <NativeSelect
                id={KIND_ID}
                className="w-full"
                value={edit.kind}
                disabled={busy}
                onChange={(event) => {
                  const next = OTHER_KINDS.find(
                    (candidate) => candidate === event.target.value,
                  );
                  if (next) setEdit({ ...edit, kind: next });
                  update.reset();
                }}
              >
                {OTHER_KINDS.map((candidate) => (
                  <NativeSelectOption key={candidate} value={candidate}>
                    {KIND_LABELS[candidate]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          )}
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

  if (current.mode === "archive" || current.mode === "restore") {
    const archiving = current.mode === "archive";
    const action = archiving ? archive : restore;
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!busy}
        eyebrow={payee.name}
        title={archiving ? `Archive ${payee.name}?` : `Restore ${payee.name}?`}
        stepKey={`${payee.id}-${current.mode}`}
        footer={
          <SheetActions kind="primary">
            <Button
              disabled={busy}
              onClick={() =>
                action.mutate(undefined, {
                  onSuccess: (saved) => {
                    setMode(
                      "detail",
                      archiving ? "Payee archived." : "Payee restored.",
                    );
                    onShow(saved);
                  },
                })
              }
            >
              {archiving
                ? archive.isPending
                  ? "Archiving…"
                  : "Archive"
                : restore.isPending
                  ? "Restoring…"
                  : "Restore"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setMode("detail")}
            >
              {archiving ? "Keep it" : "Keep archived"}
            </Button>
          </SheetActions>
        }
      >
        {archiving ? (
          <Callout tone="warn" icon={ArchiveIcon}>
            <p>
              They won’t appear for new bills or payments. Payments already made
              to them stay in the history.
            </p>
          </Callout>
        ) : (
          <Callout tone="neutral" icon={ArchiveRestoreIcon}>
            <p>
              {payee.name} shows again for new bills and payments, paid to the
              same details as before.
            </p>
          </Callout>
        )}
        {action.isError ? (
          <div role="alert">
            <Callout tone="error">
              <p>{describeApiError(action.error)}</p>
            </Callout>
          </div>
        ) : null}
      </DetailSheet>
    );
  }

  const position = <SheetPosition index={index} total={total} />;
  const billCount = payee.billCount ?? 0;

  return (
    <DetailSheet
      open
      onClose={onClose}
      eyebrow={KIND_LABELS[payee.kind]}
      title={payee.name}
      stepKey={payee.id}
      headerExtra={
        payee.archived || payee.secondConfirmationUntil ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {payee.archived ? (
              <StatusBadge tone="rejected">Archived</StatusBadge>
            ) : null}
            {payee.secondConfirmationUntil ? (
              <StatusBadge tone="waiting">{RECENTLY_CHANGED_LABEL}</StatusBadge>
            ) : null}
          </div>
        ) : null
      }
      stepper={{
        index,
        total,
        onStep,
        previousLabel: "Previous payee",
        nextLabel: "Next payee",
      }}
      footer={
        !canAct ? (
          <>
            <ReadOnlyNote>View only. Only admins change payees.</ReadOnlyNote>
            {position}
          </>
        ) : payee.archived ? (
          <>
            <Button
              variant="outline"
              onClick={() => {
                restore.reset();
                setMode("restore");
              }}
            >
              <ArchiveRestoreIcon aria-hidden="true" />
              Restore payee
            </Button>
            {position}
          </>
        ) : (
          <>
            <SheetActions kind="primary">
              <Button
                onClick={() => {
                  resetChange();
                  setDraft({
                    kind: payee.kind,
                    membershipId: "",
                    name: payee.name,
                    method: startingMethod(
                      payee.kind,
                      payee.details?.method ?? null,
                    ),
                    values: detailsToValues(payee.details),
                  });
                  setMode("details");
                }}
              >
                {payee.details ? (
                  <PencilIcon aria-hidden="true" />
                ) : (
                  <PlusIcon aria-hidden="true" />
                )}
                {detailsTitle}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  update.reset();
                  setEditError(null);
                  setEdit({ name: payee.name, kind: payee.kind });
                  setMode("edit");
                }}
              >
                Rename or change kind
              </Button>
            </SheetActions>
            <SheetActions kind="secondary">
              <Button
                variant="danger"
                size="md"
                onClick={() => {
                  archive.reset();
                  setMode("archive");
                }}
              >
                Archive payee
              </Button>
            </SheetActions>
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
      {payee.secondConfirmationUntil ? (
        <Callout tone="warn" icon={ShieldAlertIcon}>
          <p>
            Paying them before{" "}
            {formatNairobiDateTime(payee.secondConfirmationUntil)} needs a
            second confirmation.
          </p>
        </Callout>
      ) : null}
      {payee.archived ? (
        <Callout tone="neutral" icon={ArchiveIcon}>
          <p>
            This payee is archived. It can’t be paid or changed, and its history
            stays.
          </p>
        </Callout>
      ) : null}
      {payee.kind === "employee" ? (
        <DetailList>
          <TeamMember payee={payee} />
        </DetailList>
      ) : null}
      <SectionLabel>Payment details</SectionLabel>
      {payee.details ? (
        <DetailList>
          {detailRows(payee.details, {
            bankName,
            payoutPhoneConfirmed: payee.payoutPhoneConfirmed,
          }).map((row) => (
            <DetailItem key={row.label} label={row.label}>
              {row.value}
            </DetailItem>
          ))}
        </DetailList>
      ) : (
        <SheetNote>
          No payment details yet. Add them before paying this payee.
        </SheetNote>
      )}
      {payee.details?.method === "outside" ? (
        <p className="-mt-2 text-xs leading-4 text-gray-500">
          {METHOD_DESCRIPTIONS.outside}
        </p>
      ) : null}
      {payee.detailsChangedAt ? (
        <p className="-mt-1.5 text-xs leading-4 text-gray-500 tabular-nums">
          Last changed {formatNairobiDateTime(payee.detailsChangedAt)}.
        </p>
      ) : null}
      {billCount > 0 ? (
        <SheetNote icon={FileTextIcon}>
          <Link href={`/bills?payee=${payee.id}`} className={textLinkClass}>
            See bills for {payee.name}
          </Link>
          <span className="text-gray-500 tabular-nums">
            {" "}
            · {String(billCount)} {billCount === 1 ? "bill" : "bills"}
          </span>
        </SheetNote>
      ) : null}
      {isPerson(payee) ? (
        <SheetNote icon={BanknoteIcon}>
          Salaries are paid under{" "}
          <Link href="/payroll" className={textLinkClass}>
            Payroll
          </Link>
          .
        </SheetNote>
      ) : null}
    </DetailSheet>
  );
}

/** The employee's person, from the payee itself: "No longer in the team" once they leave. */
function TeamMember({ payee }: { payee: Payee }): JSX.Element {
  const member = payee.member;
  if (!member) {
    return <DetailItem label="Team member">No longer in the team.</DetailItem>;
  }
  const who = member.name ? `${member.name} · ${member.email}` : member.email;
  return member.inTeam ? (
    <DetailItem label="Team member">{who}</DetailItem>
  ) : (
    <DetailItem label="Team member" sub={who}>
      No longer in the team.
    </DetailItem>
  );
}

/**
 * Anyone in the team who can log in; accountants can't be paid, and each
 * person has at most one active payee.
 */
function EmployeePicker({
  members,
  membersError,
  activePayees,
  membershipId,
  error,
  disabled,
  onChoose,
}: {
  members: readonly Member[] | null;
  membersError: Error | null;
  activePayees: readonly Payee[];
  membershipId: string;
  error: string | undefined;
  disabled: boolean;
  onChoose: (member: Member) => void;
}): JSX.Element {
  if (membersError) {
    return (
      <div role="alert">
        <Callout tone="error">
          <p>{describeApiError(membersError)}</p>
        </Callout>
      </div>
    );
  }
  if (!members) {
    return <Skel width="100%" height={44} />;
  }
  const alreadyPayees = new Set(
    activePayees
      .filter((payee) => payee.kind === "employee")
      .map((payee) => payee.membershipId),
  );
  const eligible = members.filter(
    (candidate) =>
      candidate.role !== "accountant" &&
      candidate.status !== "removed" &&
      !alreadyPayees.has(candidate.id),
  );
  if (eligible.length === 0) {
    return (
      <SheetNote>
        Everyone in the team is already a payee. Invite someone under Team to
        add them.
      </SheetNote>
    );
  }
  return (
    <FormField id={MEMBER_ID} label="Team member" error={error}>
      <NativeSelect
        id={MEMBER_ID}
        className="w-full"
        value={membershipId}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          const chosen = eligible.find(
            (candidate) => candidate.id === event.target.value,
          );
          if (chosen) onChoose(chosen);
        }}
      >
        <NativeSelectOption value="">Choose the employee</NativeSelectOption>
        {eligible.map((candidate) => (
          <NativeSelectOption key={candidate.id} value={candidate.id}>
            {memberName(candidate)} ({candidate.email}) ·{" "}
            {candidate.payoutPhoneConfirmed
              ? "M-Pesa number confirmed"
              : "No M-Pesa number yet"}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FormField>
  );
}
