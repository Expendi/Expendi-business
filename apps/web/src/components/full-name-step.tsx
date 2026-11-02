"use client";

import type { FormEvent, JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { MeResponse } from "@expendi-business/shared";
import { updateMeRequestSchema } from "@expendi-business/shared";

import { useAuth } from "~/contexts/auth-context";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { CenteredCard } from "./centered-card";
import { alertClass, inputClass, primaryButton } from "./styles";

/**
 * Asked once, before the dashboard, of someone whose account has no name
 * yet (`GET /me` returns `user.fullName: null`); saved with `PATCH /me`.
 */
export function FullNameStep(): JSX.Element {
  const { api, privyUserId } = useAuth();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.updateMe({ fullName }),
    onSuccess: (user) =>
      queryClient.setQueryData<MeResponse>(
        queryKeys.me(privyUserId ?? ""),
        (me) => (me ? { ...me, user } : me),
      ),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = updateMeRequestSchema.safeParse({ fullName });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Enter your full name.");
      return;
    }
    save.mutate();
  }

  const error = invalid ?? (save.isError ? describeApiError(save.error) : null);

  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold">Welcome to Expendi Business</h1>
      <p className="mt-2 text-sm text-stone-600">
        Your team and your company&apos;s records show this name.
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-6">
        <label className="block text-sm">
          Your full name
          <input
            value={fullName}
            onChange={(event) => {
              setFullName(event.target.value);
              setInvalid(null);
            }}
            autoComplete="name"
            aria-invalid={invalid !== null}
            className={inputClass}
          />
        </label>
        {error ? (
          <p role="alert" className={alertClass}>
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={save.isPending}
          className={`mt-6 w-full ${primaryButton}`}
        >
          {save.isPending ? "Saving…" : "Continue"}
        </button>
      </form>
    </CenteredCard>
  );
}
