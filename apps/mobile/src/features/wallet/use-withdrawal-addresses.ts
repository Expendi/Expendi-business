import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AllowlistChange,
  WithdrawalAddress,
} from "@expendi-business/shared";
import {
  approvalChallengeSchema,
  withdrawalAddressesResponseSchema,
  withdrawalAddressSchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import { usePasskeyApproval } from "~/features/approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

function addressesPath(organizationId: string) {
  return `/organizations/${organizationId}/withdrawal-addresses` as const;
}

/** The company's allowlist (spec §6.9), oldest first. */
export function useWithdrawalAddresses(
  organizationId: string,
): UseQueryResult<WithdrawalAddress[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.withdrawalAddresses(organizationId),
    queryFn: () =>
      api.get(addressesPath(organizationId), withdrawalAddressesResponseSchema),
  });
}

/**
 * Adds or removes an address, confirmed with the admin's passkey. The API
 * binds the challenge to the exact change, and the change is sent again
 * with the signature.
 */
export function useChangeAllowlist(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<WithdrawalAddress>,
  Error,
  AllowlistChange
> {
  const api = useApi();
  const queryClient = useQueryClient();
  const path = addressesPath(organizationId);
  return usePasskeyApproval({
    request: async (change: AllowlistChange) => ({
      ...(await api.post(`${path}/changes`, change, approvalChallengeSchema)),
      change,
    }),
    confirm: (challenge, response) =>
      api.post(
        `${path}/changes/${challenge.challengeId}/confirm`,
        { change: challenge.change, response },
        withdrawalAddressSchema,
      ),
    onApproved: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.withdrawalAddresses(organizationId),
      }),
  });
}
