"use client";

import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CategoriesResponse,
  CompanyZohoResponse,
  CreateCategoryRequest,
  CreatePaidFromAccountRequest,
  ManagedCategory,
  OrganizationResponse,
  PaidFromAccount,
  PaidFromAccountsResponse,
  PasskeyCreationOptions,
  UpdateCategoryRequest,
  UpdatePaidFromAccountRequest,
} from "@expendi-business/shared";
import {
  approvalPasskeyStatusSchema,
  categoriesResponseSchema,
  companyZohoResponseSchema,
  managedCategorySchema,
  organizationResponseSchema,
  paidFromAccountSchema,
  paidFromAccountsResponseSchema,
  passkeyCreationOptionsSchema,
} from "@expendi-business/shared";

import { useAuth } from "~/contexts/auth-context";
import { billKeys } from "~/features/payment-keys";
import { ApiError } from "~/lib/api";
import {
  browserSupportsPasskeys,
  isPasskeyCancellation,
  PasskeyUnavailableError,
} from "~/lib/passkeys";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/lib/use-api";

export const settingsKeys = {
  company: (organizationId: string) => ["company", organizationId] as const,
  /** Under `queryKeys.categories`, so refreshing the pickers refreshes this too. */
  archivedCategories: (organizationId: string) =>
    [...queryKeys.categories(organizationId), "archived"] as const,
  /** Under the key Bills' picker reads, so a change refreshes both. */
  archivedPaidFromAccounts: (organizationId: string) =>
    [...billKeys.paidFromAccounts(organizationId), "archived"] as const,
  zoho: (organizationId: string) =>
    ["settings", organizationId, "zoho"] as const,
};

const paidFromAccountsPath = (organizationId: string) =>
  `/organizations/${organizationId}/paid-from-accounts` as const;

const categoriesPath = (organizationId: string) =>
  `/organizations/${organizationId}/categories` as const;

/** The company's name, KRA PIN and the caller's role. Read-only: no API edits them yet. */
export function useCompanyDetails(
  organizationId: string,
): UseQueryResult<OrganizationResponse> {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.company(organizationId),
    queryFn: () =>
      api.get(`/organizations/${organizationId}`, organizationResponseSchema),
  });
}

/** The categories new spending can pick, the same list the pickers use. */
export function useActiveCategories(
  organizationId: string,
): UseQueryResult<CategoriesResponse> {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });
}

export function useArchivedCategories(
  organizationId: string,
): UseQueryResult<CategoriesResponse> {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.archivedCategories(organizationId),
    queryFn: () =>
      api.get(
        `${categoriesPath(organizationId)}?archived=true`,
        categoriesResponseSchema,
      ),
  });
}

export type CategoryChange =
  | { readonly kind: "create"; readonly fields: CreateCategoryRequest }
  | {
      readonly kind: "update";
      readonly categoryId: string;
      readonly changes: UpdateCategoryRequest;
    }
  | { readonly kind: "archive" | "restore"; readonly categoryId: string };

/** Admins only: the API audits each change and refuses anyone else. */
export function useChangeCategory(
  organizationId: string,
): UseMutationResult<ManagedCategory, Error, CategoryChange> {
  const api = useApi();
  const queryClient = useQueryClient();
  const path = categoriesPath(organizationId);
  return useMutation({
    mutationFn: (change) => {
      switch (change.kind) {
        case "create":
          return api.post(path, change.fields, managedCategorySchema);
        case "update":
          return api.patch(
            `${path}/${change.categoryId}`,
            change.changes,
            managedCategorySchema,
          );
        case "archive":
        case "restore":
          return api.post(
            `${path}/${change.categoryId}/${change.kind}`,
            undefined,
            managedCategorySchema,
          );
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories(organizationId),
      }),
  });
}

/** The accounts company spending can be recorded as paid from (spec §6.23). */
export function usePaidFromAccounts(
  organizationId: string,
): UseQueryResult<PaidFromAccountsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: billKeys.paidFromAccounts(organizationId),
    queryFn: () =>
      api.get(
        paidFromAccountsPath(organizationId),
        paidFromAccountsResponseSchema,
      ),
  });
}

export function useArchivedPaidFromAccounts(
  organizationId: string,
): UseQueryResult<PaidFromAccountsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.archivedPaidFromAccounts(organizationId),
    queryFn: () =>
      api.get(
        `${paidFromAccountsPath(organizationId)}?archived=true`,
        paidFromAccountsResponseSchema,
      ),
  });
}

export type PaidFromAccountChange =
  | { readonly kind: "create"; readonly fields: CreatePaidFromAccountRequest }
  | {
      readonly kind: "update";
      readonly accountId: string;
      readonly changes: UpdatePaidFromAccountRequest;
    }
  | { readonly kind: "archive"; readonly accountId: string };

/** Admins only. An archived account stays on the spending that has it. */
export function useChangePaidFromAccount(
  organizationId: string,
): UseMutationResult<PaidFromAccount, Error, PaidFromAccountChange> {
  const api = useApi();
  const queryClient = useQueryClient();
  const path = paidFromAccountsPath(organizationId);
  return useMutation({
    mutationFn: (change) => {
      switch (change.kind) {
        case "create":
          return api.post(path, change.fields, paidFromAccountSchema);
        case "update":
          return api.patch(
            `${path}/${change.accountId}`,
            change.changes,
            paidFromAccountSchema,
          );
        case "archive":
          return api.post(
            `${path}/${change.accountId}/archive`,
            undefined,
            paidFromAccountSchema,
          );
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: billKeys.paidFromAccounts(organizationId),
      }),
  });
}

/**
 * The Zoho Books connection (spec §6.17), read-only: only Expendi staff
 * connect, reconnect or retry.
 */
export function useZohoStatus(
  organizationId: string,
): UseQueryResult<CompanyZohoResponse> {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.zoho(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/settings/zoho`,
        companyZohoResponseSchema,
      ),
  });
}

const CREATE_FAILED =
  "Your browser couldn't create a passkey. Try again, or choose “use a phone or tablet” to make it on your phone.";
const UNSUPPORTED =
  "This browser can't create passkeys. Use a recent Chrome, Safari, Edge or Firefox, or set it up in the app.";

/** Creates the passkey in the browser; null if the person cancels. */
async function createPasskey(
  options: PasskeyCreationOptions,
): Promise<RegistrationResponseJSON | null> {
  if (!browserSupportsPasskeys())
    throw new PasskeyUnavailableError(UNSUPPORTED);
  try {
    return await startRegistration({ optionsJSON: options });
  } catch (error) {
    if (
      isPasskeyCancellation(error) ||
      (error instanceof Error && isPasskeyCancellation(error.cause))
    ) {
      return null;
    }
    throw new PasskeyUnavailableError(CREATE_FAILED, { cause: error });
  }
}

export type EnrolmentOutcome = "enrolled" | "cancelled";

/**
 * Sets up the admin's approval passkey from the browser under the app's
 * rules (`/me/approval-passkey`): admins only, one per person, a sign-in
 * from the last few minutes, and every admin emailed.
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
        "/me/approval-passkey/options",
        undefined,
        passkeyCreationOptionsSchema,
      );
      const response = await createPasskey(options);
      if (!response) return "cancelled";
      await api.post(
        "/me/approval-passkey/verify",
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

/** The API wants a fresh sign-in before it sets up a passkey. */
export function isRecentLoginRequired(error: unknown): boolean {
  return error instanceof ApiError && error.tag === "RecentLoginRequired";
}
