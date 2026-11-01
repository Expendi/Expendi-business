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
  membersResponseSchema,
} from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

function membersPath(organizationId: string) {
  return `/organizations/${organizationId}/members` as const;
}

export function useMembers(
  organizationId: string,
): UseQueryResult<MembersResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: () => api.get(membersPath(organizationId), membersResponseSchema),
  });
}

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
 * Role changes and removals can change the caller's own access, so `/me` is
 * refreshed along with the team. A removal doesn't wait for the refresh, so
 * the member screen can close before the person drops out of the list.
 */
function useInvalidateTeamAndMe(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.members(organizationId),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.allMe }),
    ]);
}

export function useChangeMemberRole(
  organizationId: string,
): UseMutationResult<
  Member,
  Error,
  { membershipId: string; role: AssignableRole }
> {
  const api = useApi();
  const invalidate = useInvalidateTeamAndMe(organizationId);
  return useMutation({
    mutationFn: ({ membershipId, role }) =>
      api.patch(
        `${membersPath(organizationId)}/${membershipId}`,
        { role },
        memberSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useRemoveMember(
  organizationId: string,
): UseMutationResult<Member, Error, string> {
  const api = useApi();
  const invalidate = useInvalidateTeamAndMe(organizationId);
  return useMutation({
    mutationFn: (membershipId) =>
      api.delete(
        `${membersPath(organizationId)}/${membershipId}`,
        memberSchema,
      ),
    onSuccess: () => {
      void invalidate();
    },
  });
}
