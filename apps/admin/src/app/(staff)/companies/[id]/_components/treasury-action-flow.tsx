"use client";

import type { FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  StaffTreasuryAction,
  StaffTreasuryMove,
  StaffTreasuryPrepared,
} from "@expendi-business/shared";
import { STAFF_REASON_MIN_LENGTH } from "@expendi-business/shared";

import { PageError } from "~/components/page-state";
import { SecondConfirmation } from "~/components/second-confirmation";
import {
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/format";

export const TREASURY_ACTION_COPY: Record<
  StaffTreasuryAction,
  { readonly button: string; readonly hint: string; readonly confirm: string }
> = {
  return_stranded_deposit: {
    button: "Return the stranded deposit…",
    hint: "Privy rejected this move's vault deposit, so its USDC sits in the Treasury wallet. You approve sending exactly that USDC back to the company wallet; the Treasury job then sends it.",
    confirm: "Confirm: return the stranded deposit",
  },
  resume_return: {
    button: "Resume the return…",
    hint: "The withdrawal delivered USDC to the Treasury wallet but sending it back didn't finish. You approve sending exactly what is still owed; the Treasury job then sends it.",
    confirm: "Confirm: resume the return",
  },
};

/**
 * Approves sending a Treasury move's USDC back to the company wallet (spec §6.15):
 * a written reason, then the API's description of what happens, then a
 * second confirmation. Only shown to ops admins, for a move the API says
 * has something to send; the API refuses anyone else regardless.
 */
export function TreasuryActionFlow({
  organizationId,
  move,
  action,
}: {
  organizationId: string;
  move: StaffTreasuryMove;
  action: NonNullable<StaffTreasuryMove["action"]>;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const copy = TREASURY_ACTION_COPY[action.kind];
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<StaffTreasuryPrepared | null>(null);

  const prepare = useMutation({
    mutationFn: () =>
      api.ops.prepareTreasuryAction(organizationId, move.id, action.kind, {
        reason,
      }),
    onSuccess: setPrepared,
  });

  const confirm = useMutation({
    mutationFn: (token: string) =>
      api.ops.confirmTreasuryAction(
        organizationId,
        move.id,
        action.kind,
        token,
      ),
    onSuccess: async () => {
      setOpen(false);
      setPrepared(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["internal"] });
    },
  });

  function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    prepare.mutate();
  }

  if (!open) {
    return (
      <div className="mt-4">
        <p className="text-sm text-muted-foreground">{copy.hint}</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${primaryButton} mt-2`}
        >
          {copy.button}
        </button>
      </div>
    );
  }

  if (prepared) {
    return (
      <div className="mt-4">
        <SecondConfirmation
          title={copy.button.replace("…", "")}
          consequences={prepared.consequences}
          reason={prepared.reason}
          expiresAt={prepared.expiresAt}
          confirmLabel={copy.confirm}
          pending={confirm.isPending}
          error={confirm.isError ? describeApiError(confirm.error) : null}
          onConfirm={() => confirm.mutate(prepared.token)}
          onBack={() => {
            setPrepared(null);
            confirm.reset();
          }}
        >
          <p className="mt-2 text-sm">
            Approves at most {formatUsdc(prepared.amountUsdc)}.
          </p>
        </SecondConfirmation>
      </div>
    );
  }

  return (
    <form
      onSubmit={onReview}
      className="mt-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <p className="text-sm">{copy.hint}</p>
      <p className="mt-2 text-sm">
        It would approve {formatUsdc(action.amountUsdc)}.
      </p>
      <label className="mt-4 block text-sm font-medium">
        Reason (at least {STAFF_REASON_MIN_LENGTH} characters, kept in the audit
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
          {prepare.isPending ? "Checking the move…" : "Review"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            prepare.reset();
          }}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
