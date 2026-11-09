"use client";

import type { JSX } from "react";
import { KeyRoundIcon, UsersIcon } from "lucide-react";
import { useId, useState } from "react";

import type { CardActionRequest, ExpendiCard } from "@expendi-business/shared";
import {
  CARD_NICKNAME_MAX_LENGTH,
  cardActionSchema,
} from "@expendi-business/shared";

import type { FieldErrors } from "~/app/(company)/payroll/_components/sheet-parts";
import type { PasskeyState } from "~/features/payment-ui";
import { personName } from "~/app/(company)/expenses/_components/expense-labels";
import {
  errorsByField,
  focusFirstError,
} from "~/app/(company)/payroll/_components/sheet-parts";
import { useCategories } from "~/app/(company)/payroll/_components/use-categories";
import { useMembers } from "~/app/(company)/team/_components/team-api";
import {
  Callout,
  DetailSheet,
  SheetActions,
} from "~/components/data/detail-sheet";
import { EmptyState, Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { ROLE_LABELS } from "~/config/roles";
import {
  FormField,
  PasskeySetupCallout,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { useCardAction } from "./cards-api";
import { eligibleCardholders } from "./cards-display";

interface Draft {
  readonly membershipId: string;
  readonly nickname: string;
  readonly monthlyLimitUsd: string;
  readonly defaultCategoryId: string;
}

const NO_DRAFT: Draft = {
  membershipId: "",
  nickname: "",
  monthlyLimitUsd: "",
  defaultCategoryId: "",
};

/**
 * Issues a virtual card (spec §6.25): who holds it, what it's called, its
 * required monthly limit and default category, confirmed with the passkey.
 */
export function IssueCardSheet({
  organizationId,
  passkey,
  onClose,
  onIssued,
}: {
  organizationId: string;
  passkey: PasskeyState;
  onClose: () => void;
  onIssued: (card: ExpendiCard) => void;
}): JSX.Element {
  const members = useMembers(organizationId);
  const categories = useCategories(organizationId);
  const action = useCardAction(organizationId);
  const formId = useId();
  const ids = {
    membershipId: useId(),
    nickname: useId(),
    monthlyLimitUsd: useId(),
    defaultCategoryId: useId(),
  };
  const [draft, setDraft] = useState(NO_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});

  const holders = members.data ? eligibleCardholders(members.data) : [];
  const failed = members.isError ? members.error : categories.error;

  function change<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit() {
    const request: CardActionRequest = { type: "issue_card", ...draft };
    const parsed = cardActionSchema.safeParse(request);
    if (!parsed.success) {
      const found = errorsByField(parsed.error.issues);
      setErrors(found);
      focusFirstError(found, ids);
      return;
    }
    setErrors({});
    action.mutate(request, {
      onSuccess: (outcome) => {
        if (
          outcome.status === "approved" &&
          outcome.result.type === "issue_card"
        ) {
          onIssued(outcome.result.card);
        }
      },
    });
  }

  const ready =
    passkey === "ready" &&
    members.isSuccess &&
    categories.isSuccess &&
    holders.length > 0;

  return (
    <DetailSheet
      open
      onClose={onClose}
      dismissible={!action.isPending}
      eyebrow="Expendi cards"
      title="Issue card"
      footer={
        ready ? (
          <SheetActions kind="primary">
            <Button type="submit" form={formId} disabled={action.isPending}>
              {action.isPending ? (
                "Waiting for your passkey…"
              ) : (
                <>
                  <KeyRoundIcon aria-hidden="true" />
                  Issue with passkey
                </>
              )}
            </Button>
            <Button
              variant="outline"
              disabled={action.isPending}
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
      {passkey === "missing" ? (
        <PasskeySetupCallout />
      ) : passkey === "checking" ||
        members.isPending ||
        categories.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-4">
          <Skel width="100%" height={60} />
          <Skel width="100%" height={60} />
          <Skel width="100%" height={60} />
        </div>
      ) : failed ? (
        <Callout
          tone="error"
          action={
            <Button
              variant="outline"
              size="md"
              onClick={() => {
                void members.refetch();
                void categories.refetch();
              }}
            >
              Try again
            </Button>
          }
        >
          {describeApiError(failed)}
        </Callout>
      ) : holders.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No one can hold a card yet">
          Cards go to admins and employees who&apos;ve signed in. Invite someone
          from Team first.
        </EmptyState>
      ) : (
        <SheetForm id={formId} label="Issue card" onSubmit={submit}>
          <FormField
            id={ids.membershipId}
            label="Cardholder"
            error={errors.membershipId}
          >
            <NativeSelect
              id={ids.membershipId}
              className="w-full"
              value={draft.membershipId}
              disabled={action.isPending}
              aria-invalid={errors.membershipId ? true : undefined}
              onChange={(event) => change("membershipId", event.target.value)}
            >
              <NativeSelectOption value="">Choose someone</NativeSelectOption>
              {holders.map((member) => (
                <NativeSelectOption key={member.id} value={member.id}>
                  {personName(member)} ({ROLE_LABELS[member.role]})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          <FormField
            id={ids.nickname}
            label="Card name"
            help="Only your company sees this, e.g. Marketing subscriptions."
            error={errors.nickname}
          >
            <Input
              id={ids.nickname}
              maxLength={CARD_NICKNAME_MAX_LENGTH}
              autoComplete="off"
              value={draft.nickname}
              disabled={action.isPending}
              aria-invalid={errors.nickname ? true : undefined}
              onChange={(event) => change("nickname", event.target.value)}
            />
          </FormField>
          <FormField
            id={ids.monthlyLimitUsd}
            label="Monthly limit (USD)"
            help="Spending stops at this amount each calendar month."
            error={errors.monthlyLimitUsd}
          >
            <Input
              id={ids.monthlyLimitUsd}
              inputMode="decimal"
              autoComplete="off"
              placeholder="500.00"
              value={draft.monthlyLimitUsd}
              disabled={action.isPending}
              aria-invalid={errors.monthlyLimitUsd ? true : undefined}
              onChange={(event) =>
                change("monthlyLimitUsd", event.target.value)
              }
            />
          </FormField>
          <FormField
            id={ids.defaultCategoryId}
            label="Default category"
            help="Purchases start in this category."
            error={errors.defaultCategoryId}
          >
            <NativeSelect
              id={ids.defaultCategoryId}
              className="w-full"
              value={draft.defaultCategoryId}
              disabled={action.isPending}
              aria-invalid={errors.defaultCategoryId ? true : undefined}
              onChange={(event) =>
                change("defaultCategoryId", event.target.value)
              }
            >
              <NativeSelectOption value="">
                Choose a category
              </NativeSelectOption>
              {(categories.data ?? []).map((category) => (
                <NativeSelectOption key={category.id} value={category.id}>
                  {category.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          {action.data?.status === "cancelled" ? (
            <SheetNote>Cancelled. No card was issued.</SheetNote>
          ) : null}
          {action.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApprovalError(action.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      )}
    </DetailSheet>
  );
}
