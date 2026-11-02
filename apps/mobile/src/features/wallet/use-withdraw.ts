import type { UseMutationResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";

import type {
  CreateWithdrawalRequest,
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
 * withdrawal and a passkey challenge bound to its address and amount; the
 * admin signs; the API approves and sends it, once. The same `requestId`
 * always means the same withdrawal.
 */
export function useWithdraw(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<Withdrawal>,
  Error,
  CreateWithdrawalRequest & { readonly address: string }
> {
  const api = useApi();
  const queryClient = useQueryClient();
  const path = `/organizations/${organizationId}/withdrawals` as const;
  return usePasskeyApproval({
    request: async ({ address, ...request }) => {
      const challenge = await api.post(
        path,
        request,
        withdrawalChallengeSchema,
      );
      // Sign only what the admin reviewed.
      if (
        challenge.withdrawal.amountUsdc !== request.amountUsdc ||
        challenge.withdrawal.address !== address.toLowerCase()
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
