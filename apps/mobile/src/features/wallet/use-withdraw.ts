import type { UseMutationResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";

import type {
  CreateWithdrawalRequest,
  PayeeChain,
  Withdrawal,
} from "@expendi-business/shared";
import {
  withdrawalChallengeSchema,
  withdrawalSchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import { usePasskeyApproval } from "~/features/approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";
import { isReviewedWithdrawal } from "./withdrawal-check";

export class WithdrawalMismatchError extends Error {
  override readonly name = "WithdrawalMismatchError";

  constructor() {
    super(
      "The withdrawal Expendi prepared doesn't match what you entered. Nothing was sent. Check the details and try again.",
    );
  }
}

/**
 * Withdraws to an allowlisted address (spec §6.9): the API prepares the
 * withdrawal and a passkey challenge bound to its payee chain, address and
 * amount; the
 * admin signs; the API approves and sends it, once. The same `requestId`
 * always means the same withdrawal.
 */
export function useWithdraw(organizationId: string): UseMutationResult<
  ApprovalOutcome<Withdrawal>,
  Error,
  CreateWithdrawalRequest & {
    readonly chain: PayeeChain;
    readonly address: string;
  }
> {
  const api = useApi();
  const queryClient = useQueryClient();
  const path = `/organizations/${organizationId}/withdrawals` as const;
  return usePasskeyApproval({
    request: async ({ chain, address, ...request }) => {
      const challenge = await api.post(
        path,
        request,
        withdrawalChallengeSchema,
      );
      if (
        !isReviewedWithdrawal(challenge.withdrawal, {
          chain,
          address,
          amountUsdc: request.amountUsdc,
        })
      ) {
        throw new WithdrawalMismatchError();
      }
      return challenge;
    },
    confirm: (challenge, response) =>
      api.post(
        `${path}/${challenge.challengeId}/confirm`,
        { response },
        withdrawalSchema,
      ),
    onApproved: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.wallet(organizationId),
      }),
  });
}
