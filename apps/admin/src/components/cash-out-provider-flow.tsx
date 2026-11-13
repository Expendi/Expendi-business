"use client";

import type { FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  CashOutProvider,
  CashOutProviderPrepared,
} from "@expendi-business/shared";
import { STAFF_REASON_MIN_LENGTH } from "@expendi-business/shared";

import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { PageError } from "./page-state";
import { SecondConfirmation } from "./second-confirmation";
import { inputClass, primaryButton, secondaryButton } from "./styles";

export const CASH_OUT_PROVIDER_NAMES: Record<CashOutProvider, string> = {
  paycrest: "Paycrest",
  pretium: "Pretium",
};

/**
 * Make `provider` the active cash-out provider for every company, with the
 * pause's steps: a written reason, then the API's description of what
 * happens, then a second confirmation. Only shown to ops admins, and only
 * enabled while `provider` is ready; the API checks both again regardless.
 */
export function CashOutProviderFlow({
  provider,
  ready,
}: {
  provider: CashOutProvider;
  ready: boolean;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<CashOutProviderPrepared | null>(
    null,
  );
  const label = `Send new cash-outs through ${CASH_OUT_PROVIDER_NAMES[provider]}`;
  const notReadyId = `cash-out-provider-${provider}-not-ready`;

  const prepare = useMutation({
    mutationFn: () =>
      api.ops.prepareCashOutProviderChange({ provider, reason }),
    onSuccess: setPrepared,
  });

  const confirm = useMutation({
    mutationFn: (token: string) => api.ops.confirmCashOutProviderChange(token),
    onSuccess: async () => {
      setOpen(false);
      setPrepared(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["internal"] });
    },
  });

  function reset() {
    setOpen(false);
    setPrepared(null);
    prepare.reset();
    confirm.reset();
  }

  function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    prepare.mutate();
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!ready}
          aria-describedby={ready ? undefined : notReadyId}
          className={secondaryButton}
        >
          {label}
        </button>
        {ready ? null : (
          <p id={notReadyId} className="mt-2 text-sm text-muted-foreground">
            {CASH_OUT_PROVIDER_NAMES[provider]} can&apos;t be chosen until the
            problems above are fixed.
          </p>
        )}
      </div>
    );
  }

  if (prepared) {
    return (
      <SecondConfirmation
        title={label}
        consequences={prepared.consequences}
        reason={prepared.reason}
        expiresAt={prepared.expiresAt}
        confirmLabel={`Confirm: switch to ${CASH_OUT_PROVIDER_NAMES[provider]}`}
        pending={confirm.isPending}
        error={confirm.isError ? describeApiError(confirm.error) : null}
        onConfirm={() => confirm.mutate(prepared.token)}
        onBack={() => {
          setPrepared(null);
          confirm.reset();
        }}
      />
    );
  }

  return (
    <form
      onSubmit={onReview}
      className="rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <label className="block text-sm font-medium">
        Why? (at least {STAFF_REASON_MIN_LENGTH} characters, kept in the audit
        log)
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          required
          minLength={STAFF_REASON_MIN_LENGTH}
          className={inputClass}
        />
      </label>
      {prepare.isError ? (
        <PageError>{describeApiError(prepare.error)}</PageError>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={prepare.isPending}
          className={primaryButton}
        >
          {prepare.isPending ? "Checking…" : "Review"}
        </button>
        <button type="button" onClick={reset} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
