"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";

import type {
  ApprovalChallenge,
  ApprovalPasskeyStatus,
} from "@expendi-business/shared";

import type { ApprovalOutcome, PasskeyApprovalSteps } from "./approval";
import { useAuth } from "~/contexts/auth-context";
import { approveWithPasskey } from "./approval";
import { queryKeys } from "./query-keys";

/** Whether the signed-in admin has set up their approval passkey. */
export function useApprovalPasskeyStatus(
  enabled = true,
): UseQueryResult<ApprovalPasskeyStatus> {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.approvalPasskey,
    queryFn: () => api.getApprovalPasskeyStatus(),
    enabled,
  });
}

/**
 * A money action confirmed with the admin's passkey: get a challenge, sign
 * it in the browser, send it back once (`approveWithPasskey`).
 */
export function usePasskeyApproval<
  TVariables,
  TChallenge extends ApprovalChallenge,
  TResult,
>(
  steps: PasskeyApprovalSteps<TVariables, TChallenge, TResult> & {
    readonly onApproved?: (result: TResult) => Promise<unknown>;
  },
): UseMutationResult<ApprovalOutcome<TResult>, Error, TVariables> {
  return useMutation({
    mutationFn: (variables) => approveWithPasskey(steps, variables),
    onSuccess: async (outcome) => {
      if (outcome.status === "approved") {
        await steps.onApproved?.(outcome.result);
      }
    },
  });
}
