import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ApprovalChallenge,
  ApprovalPasskeyStatus,
} from "@expendi-business/shared";
import {
  approvalPasskeyStatusSchema,
  passkeyCreationOptionsSchema,
} from "@expendi-business/shared";

import type { PasskeyAssertion } from "./passkey-ceremony";
import { ApiError, describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";
import {
  createApprovalPasskey,
  PasskeyUnavailableError,
  signApprovalChallenge,
} from "./passkey-ceremony";

const PASSKEY_PATH = "/me/approval-passkey";

/** Whether the signed-in person has set up their approval passkey. */
export function useApprovalPasskeyStatus(): UseQueryResult<ApprovalPasskeyStatus> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.approvalPasskey,
    queryFn: () => api.get(PASSKEY_PATH, approvalPasskeyStatusSchema),
  });
}

export type EnrolmentOutcome = "enrolled" | "cancelled";

/**
 * Sets up the approval passkey: options from the API, the passkey created
 * on this phone, then verified and stored by the API. Enrolling needs a
 * sign-in from the last few minutes; see `isRecentLoginRequired`.
 */
export function useEnrolApprovalPasskey(): UseMutationResult<
  EnrolmentOutcome,
  Error,
  void
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const options = await api.post(
        `${PASSKEY_PATH}/options`,
        undefined,
        passkeyCreationOptionsSchema,
      );
      const response = await createApprovalPasskey(options);
      if (!response) return "cancelled";
      await api.post(
        `${PASSKEY_PATH}/verify`,
        { response },
        approvalPasskeyStatusSchema,
      );
      return "enrolled";
    },
    onSuccess: (outcome) => {
      if (outcome === "enrolled") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.approvalPasskey,
        });
      }
    },
  });
}

export type ApprovalOutcome<TResult> =
  | { readonly status: "approved"; readonly result: TResult }
  | { readonly status: "cancelled" };

export interface PasskeyApprovalSteps<
  TVariables,
  TChallenge extends ApprovalChallenge,
  TResult,
> {
  /** Asks the API for a challenge bound to exactly this action. */
  readonly request: (variables: TVariables) => Promise<TChallenge>;
  /** Sends the signed challenge back; the API approves and acts on it. */
  readonly confirm: (
    challenge: TChallenge,
    assertion: PasskeyAssertion,
  ) => Promise<TResult>;
  readonly onApproved?: (result: TResult) => Promise<unknown>;
}

/**
 * Any money action confirmed with the admin's passkey (withdrawals,
 * allowlist changes, Approve & pay): get a challenge, sign it with the
 * fingerprint or face prompt, send it back. Backing out of the prompt is
 * `cancelled`, not an error, and nothing happens.
 */
export function usePasskeyApproval<
  TVariables,
  TChallenge extends ApprovalChallenge,
  TResult,
>(
  steps: PasskeyApprovalSteps<TVariables, TChallenge, TResult>,
): UseMutationResult<ApprovalOutcome<TResult>, Error, TVariables> {
  return useMutation({
    mutationFn: async (variables): Promise<ApprovalOutcome<TResult>> => {
      const challenge = await steps.request(variables);
      const assertion = await signApprovalChallenge(challenge.options);
      if (!assertion) return { status: "cancelled" };
      return {
        status: "approved",
        result: await steps.confirm(challenge, assertion),
      };
    },
    onSuccess: async (outcome) => {
      if (outcome.status === "approved")
        await steps.onApproved?.(outcome.result);
    },
  });
}

/** The API wants a fresh sign-in before it enrols a passkey. */
export function isRecentLoginRequired(error: unknown): boolean {
  return error instanceof ApiError && error.tag === "RecentLoginRequired";
}

/** What to tell the admin when a passkey step fails. */
export function describeApprovalError(error: unknown): string {
  return error instanceof PasskeyUnavailableError
    ? error.message
    : describeApiError(error);
}
