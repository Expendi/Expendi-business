"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AssignableRole,
  InviteMemberRequest,
  InviteMemberResponse,
  Member,
  MembersResponse,
} from "@expendi-business/shared";
import {
  inviteMemberResponseSchema,
  memberSchema,
} from "@expendi-business/shared";

import { useAuth } from "~/contexts/auth-context";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/lib/use-api";

/**
 * The team routes the app uses (T13, T46): list, invite, change a role,
 * remove. Admins only; the API refuses anyone else.
 */

const membersPath = (organizationId: string) =>
  `/organizations/${organizationId}/members` as const;

export function useMembers(
  organizationId: string,
): UseQueryResult<MembersResponse> {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: () => api.listMembers(organizationId),
  });
}

/** Inviting someone who is still invited sends their email again. */
export function useInviteMember(
  organizationId: string,
): UseMutationResult<InviteMemberResponse, Error, InviteMemberRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitation) =>
      api.post(
        membersPath(organizationId),
        invitation,
        inviteMemberResponseSchema,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.members(organizationId),
      }),
  });
}

/**
 * Role changes and removals can change the admin's own access, so `/me`
 * is refreshed along with the team.
 */
function useRefreshTeamAndMe(organizationId: string) {
  const queryClient = useQueryClient();
  const { privyUserId } = useAuth();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.members(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.me(privyUserId ?? ""),
      }),
    ]);
}

export function useChangeMemberRole(
  organizationId: string,
): UseMutationResult<
  Member,
  Error,
  { readonly membershipId: string; readonly role: AssignableRole }
> {
  const api = useApi();
  const refresh = useRefreshTeamAndMe(organizationId);
  return useMutation({
    mutationFn: ({ membershipId, role }) =>
      api.patch(
        `${membersPath(organizationId)}/${membershipId}`,
        { role },
        memberSchema,
      ),
    onSuccess: refresh,
  });
}

export function useRemoveMember(
  organizationId: string,
): UseMutationResult<Member, Error, string> {
  const api = useApi();
  const refresh = useRefreshTeamAndMe(organizationId);
  return useMutation({
    mutationFn: (membershipId) =>
      api.delete(
        `${membersPath(organizationId)}/${membershipId}`,
        memberSchema,
      ),
    onSuccess: refresh,
  });
}
