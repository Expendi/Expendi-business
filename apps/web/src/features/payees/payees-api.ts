"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CreatePayeeRequest,
  CreatePayeeResponse,
  Payee,
  PayeeBanksResponse,
  PayeeChangeChallenge,
  PayeeDetails,
  UpdatePayeeRequest,
  WithdrawalAddress,
} from "@expendi-business/shared";
import {
  createPayeeResponseSchema,
  payeeBanksResponseSchema,
  payeeChangeChallengeSchema,
  payeeSchema,
  payeesResponseSchema,
  withdrawalAddressesResponseSchema,
} from "@expendi-business/shared";

import type { PayeeListFilters } from "~/features/payment-keys";
import type { ApiClient } from "~/lib/api";
import type { ApprovalOutcome, PasskeyApprovalSteps } from "~/lib/approval";
import { payeeKeys } from "~/features/payment-keys";
import { useApi } from "~/lib/use-api";
import { usePasskeyApproval } from "~/lib/use-approval";

/**
 * The payee routes the app uses (T34, spec §6.19): admins add and change
 * payees, accountants read them. New payment details are confirmed with
 * the admin's passkey, bound to exactly that change.
 */

const BANKS_STALE_MS = 60 * 60_000;

export const ACTIVE_PAYEES: PayeeListFilters = {
  kind: null,
  method: null,
  archived: false,
};

const payeesPath = (organizationId: string) =>
  `/organizations/${organizationId}/payees` as const;

function listQuery({ kind, method, archived }: PayeeListFilters): string {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (method) params.set("method", method);
  if (archived) params.set("archived", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function listPayees(
  api: ApiClient,
  organizationId: string,
  filters: PayeeListFilters,
): Promise<Payee[]> {
  return api.get(
    `${payeesPath(organizationId)}${listQuery(filters)}`,
    payeesResponseSchema,
  );
}

export type PayeeChangeRequest =
  | { readonly action: "create"; readonly payee: CreatePayeeRequest }
  | {
      readonly action: "change_details";
      readonly payeeId: string;
      readonly details: PayeeDetails;
    };

/**
 * A new payee, or new payment details. A payee with no details, or paid
 * outside Expendi, is `created` at once; anything else comes back as a
 * passkey challenge echoing the change exactly as the API normalised it.
 */
export function requestPayeeChange(
  api: ApiClient,
  organizationId: string,
  request: PayeeChangeRequest,
): Promise<CreatePayeeResponse> {
  const path = payeesPath(organizationId);
  return request.action === "create"
    ? api.post(path, request.payee, createPayeeResponseSchema)
    : api.post(
        `${path}/${request.payeeId}/details`,
        { details: request.details },
        payeeChangeChallengeSchema,
      );
}

/** The change goes back exactly as the API echoed it, with the signature. */
export function payeeChangeSteps(
  api: ApiClient,
  organizationId: string,
): PasskeyApprovalSteps<PayeeChangeChallenge, PayeeChangeChallenge, Payee> {
  return {
    request: (challenge) => Promise.resolve(challenge),
    confirm: (challenge, response) =>
      api.post(
        `${payeesPath(organizationId)}/changes/${challenge.challengeId}/confirm`,
        { change: challenge.change, response },
        payeeSchema,
      ),
  };
}

/** The company's payees, A to Z. */
export function usePayees(
  organizationId: string,
  filters: PayeeListFilters,
): UseQueryResult<Payee[]> {
  const api = useApi();
  return useQuery({
    queryKey: payeeKeys.list(organizationId, filters),
    queryFn: () => listPayees(api, organizationId, filters),
  });
}

export function usePayee(
  organizationId: string,
  payeeId: string,
): UseQueryResult<Payee> {
  const api = useApi();
  return useQuery({
    queryKey: payeeKeys.detail(organizationId, payeeId),
    queryFn: () =>
      api.get(`${payeesPath(organizationId)}/${payeeId}`, payeeSchema),
  });
}

/** Kenyan banks Paycrest can pay; the list rarely changes. */
export function usePayeeBanks(
  organizationId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<PayeeBanksResponse> {
  const api = useApi();
  return useQuery({
    queryKey: payeeKeys.banks(organizationId),
    queryFn: () =>
      api.get(`${payeesPath(organizationId)}/banks`, payeeBanksResponseSchema),
    staleTime: BANKS_STALE_MS,
    enabled,
  });
}

/** The bank's name from Paycrest's list, once it has loaded. */
export function useBankName(
  organizationId: string,
  details: PayeeDetails | null,
): string | null {
  const bankCode = details?.method === "bank" ? details.bankCode : null;
  const banks = usePayeeBanks(organizationId, { enabled: bankCode !== null });
  return banks.data?.find((bank) => bank.code === bankCode)?.name ?? null;
}

/** USDC payees are paid only to an address on this list (spec §6.19). */
export function useAllowlistedAddresses(
  organizationId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<WithdrawalAddress[]> {
  const api = useApi();
  return useQuery({
    queryKey: payeeKeys.allowlist(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/withdrawal-addresses`,
        withdrawalAddressesResponseSchema,
      ),
    enabled,
  });
}

function useStorePayee(organizationId: string) {
  const queryClient = useQueryClient();
  return (payee: Payee) => {
    queryClient.setQueryData(payeeKeys.detail(organizationId, payee.id), payee);
    return queryClient.invalidateQueries({
      queryKey: payeeKeys.all(organizationId),
    });
  };
}

export function useRequestPayeeChange(
  organizationId: string,
): UseMutationResult<CreatePayeeResponse, Error, PayeeChangeRequest> {
  const api = useApi();
  const storePayee = useStorePayee(organizationId);
  return useMutation({
    mutationFn: (request) => requestPayeeChange(api, organizationId, request),
    onSuccess: (response) =>
      response.status === "created" ? storePayee(response.payee) : undefined,
  });
}

/**
 * Signs a reviewed challenge with the admin's passkey. Backing out of the
 * passkey prompt is `cancelled` and changes nothing.
 */
export function useConfirmPayeeChange(
  organizationId: string,
): UseMutationResult<ApprovalOutcome<Payee>, Error, PayeeChangeChallenge> {
  const api = useApi();
  const storePayee = useStorePayee(organizationId);
  return usePasskeyApproval({
    ...payeeChangeSteps(api, organizationId),
    onApproved: storePayee,
  });
}

/** Renames a payee or changes its kind; no passkey needed. */
export function useUpdatePayee(
  organizationId: string,
  payeeId: string,
): UseMutationResult<Payee, Error, UpdatePayeeRequest> {
  const api = useApi();
  const storePayee = useStorePayee(organizationId);
  return useMutation({
    mutationFn: (update) =>
      api.patch(
        `${payeesPath(organizationId)}/${payeeId}`,
        update,
        payeeSchema,
      ),
    onSuccess: storePayee,
  });
}

/** Hides the payee from new bills and payments; its history stays. */
export function useArchivePayee(
  organizationId: string,
  payeeId: string,
): UseMutationResult<Payee, Error, void> {
  const api = useApi();
  const storePayee = useStorePayee(organizationId);
  return useMutation({
    mutationFn: () =>
      api.post(
        `${payeesPath(organizationId)}/${payeeId}/archive`,
        undefined,
        payeeSchema,
      ),
    onSuccess: storePayee,
  });
}
