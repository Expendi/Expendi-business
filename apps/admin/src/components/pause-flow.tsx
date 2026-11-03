"use client";

import type { FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { PausePrepared } from "@expendi-business/shared";
import { STAFF_REASON_MIN_LENGTH } from "@expendi-business/shared";

import type { PauseAction } from "~/lib/internal-api";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { PageError } from "./page-state";
import { SecondConfirmation } from "./second-confirmation";
import { inputClass, primaryButton, secondaryButton } from "./styles";

/**
 * Pause or unpause payouts, for every company or one: a written reason,
 * then the API's description of what happens, then a second confirmation.
 * Only shown to ops admins; the API refuses anyone else regardless.
 */
export function PauseFlow({
  action,
  organizationId,
  label,
}: {
  action: PauseAction;
  /** Omit for every company's payouts. */
  organizationId?: string;
  label: string;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<PausePrepared | null>(null);

  const prepare = useMutation({
    mutationFn: () =>
      api.ops.preparePause(
        action,
        organizationId
          ? { scope: "company", organizationId, reason }
          : { scope: "platform", reason },
      ),
    onSuccess: setPrepared,
  });

  const confirm = useMutation({
    mutationFn: (token: string) => api.ops.confirmPause(action, token),
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={secondaryButton}
      >
        {label}
      </button>
    );
  }

  if (prepared) {
    return (
      <SecondConfirmation
        title={label}
        consequences={prepared.consequences}
        reason={prepared.reason}
        expiresAt={prepared.expiresAt}
        confirmLabel={`Confirm: ${action}`}
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
