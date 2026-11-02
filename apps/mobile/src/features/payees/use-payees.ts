import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CreatePayeeRequest,
  CreatePayeeResponse,
  Payee,
  PayeeBanksResponse,
  PayeeChangeChallenge,
  PayeeDetails,
  PayeeKind,
  PayeeMethod,
  UpdatePayeeRequest,
} from "@expendi-business/shared";
import {
  createPayeeResponseSchema,
  payeeBanksResponseSchema,
  payeeChangeChallengeSchema,
  payeeSchema,
  payeesResponseSchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import { usePasskeyApproval } from "~/features/approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

const BANKS_STALE_MS = 60 * 60_000;

function payeesPath(organizationId: string) {
  return `/organizations/${organizationId}/payees` as const;
}

export interface PayeeListFilters {
  readonly kind: PayeeKind | null;
  readonly method: PayeeMethod | null;
  /** True lists only archived payees; the API leaves them out otherwise. */
  readonly archived: boolean;
}

function listQuery({ kind, method, archived }: PayeeListFilters): string {
  const params = [
    kind && `kind=${kind}`,
    method && `method=${method}`,
    archived && "archived=true",
  ].filter(Boolean);
  return params.length > 0 ? `?${params.join("&")}` : "";
}

/** The company's payees (spec §6.19), A to Z. Admins only. */
export function usePayees(
  organizationId: string,
  filters: PayeeListFilters,
): UseQueryResult<Payee[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.payeeList(organizationId, filters),
    queryFn: () =>
      api.get(
        `${payeesPath(organizationId)}${listQuery(filters)}`,
        payeesResponseSchema,
      ),
  });
}

export function usePayee(
  organizationId: string,
  payeeId: string,
): UseQueryResult<Payee> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.payee(organizationId, payeeId),
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
    queryKey: queryKeys.payeeBanks(organizationId),
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

function useStorePayee(organizationId: string) {
  const queryClient = useQueryClient();
  return (payee: Payee) => {
    queryClient.setQueryData(queryKeys.payee(organizationId, payee.id), payee);
    return queryClient.invalidateQueries({
      queryKey: queryKeys.payees(organizationId),
    });
  };
}

export type PayeeChangeRequest =
  | { readonly action: "create"; readonly payee: CreatePayeeRequest }
  | {
      readonly action: "change_details";
      readonly payeeId: string;
      readonly details: PayeeDetails;
    };

/**
 * Asks the API to add a payee or change its payment details. A payee with
 * no details, or paid outside Expendi, is `created` at once; anything else
 * comes back as a passkey challenge echoing the change exactly as the API
 * normalised it, for the admin to review before signing.
 */
export function useRequestPayeeChange(
  organizationId: string,
): UseMutationResult<CreatePayeeResponse, Error, PayeeChangeRequest> {
  const api = useApi();
  const storePayee = useStorePayee(organizationId);
  const path = payeesPath(organizationId);
  return useMutation({
    mutationFn: (request): Promise<CreatePayeeResponse> =>
      request.action === "create"
        ? api.post(path, request.payee, createPayeeResponseSchema)
        : api.post(
            `${path}/${request.payeeId}/details`,
            { details: request.details },
            payeeChangeChallengeSchema,
          ),
    onSuccess: (response) =>
      response.status === "created" ? storePayee(response.payee) : undefined,
  });
}

/**
 * Signs a reviewed challenge with the admin's passkey and sends the change
 * back exactly as the API echoed it. Backing out of the passkey prompt is
 * `cancelled` and changes nothing.
 */
export function useConfirmPayeeChange(
  organizationId: string,
): UseMutationResult<ApprovalOutcome<Payee>, Error, PayeeChangeChallenge> {
  const api = useApi();
  const storePayee = useStorePayee(organizationId);
  const path = payeesPath(organizationId);
  return usePasskeyApproval({
    request: (challenge: PayeeChangeChallenge) => Promise.resolve(challenge),
    confirm: (challenge, response) =>
      api.post(
        `${path}/changes/${challenge.challengeId}/confirm`,
        { change: challenge.change, response },
        payeeSchema,
      ),
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
