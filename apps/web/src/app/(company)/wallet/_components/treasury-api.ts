"use client";

import type {
  QueryClient,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  matchQuery,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type {
  ApprovalChallenge,
  TreasuryMoveDirection,
  TreasuryMovePreview,
  TreasuryMoveRequest,
  TreasuryMoveSummary,
  TreasuryStatus,
} from "@expendi-business/shared";
import {
  treasuryMoveChallengeSchema,
  treasuryMoveListSchema,
  treasuryMovePreviewSchema,
  treasuryMoveSchema,
  treasuryStatusSchema,
  turnOnTreasuryChallengeSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import type { ApprovalOutcome } from "~/lib/approval";
import type { PasskeyAssertion } from "~/lib/passkeys";
import { useApi } from "~/lib/use-api";
import { usePasskeyApproval } from "~/lib/use-approval";
import { walletKeys } from "./wallet-api";

/**
 * The Treasury routes the dashboard uses (spec §5, §9): the account's
 * figures, its moves, and the two actions an admin confirms with the
 * approval passkey (turning it on, moving money either way).
 */

/** Under the wallet's keys, so whatever refreshes the wallet refreshes Treasury too. */
export const treasuryKeys = {
  status: (organizationId: string) =>
    [...walletKeys.all(organizationId), "treasury"] as const,
  moves: (organizationId: string) =>
    [...walletKeys.all(organizationId), "treasury", "moves"] as const,
  preview: (
    organizationId: string,
    direction: TreasuryMoveDirection,
    amountUsdc: string,
  ) =>
    [
      ...walletKeys.all(organizationId),
      "treasury",
      "preview",
      direction,
      amountUsdc,
    ] as const,
};

const treasuryPath = (organizationId: string) =>
  `/organizations/${organizationId}/treasury` as const;

/** A move in flight is asked about again at this pace. */
const OPEN_MOVE_POLL_MS = 10_000;

const hasOpenMove = (status: TreasuryStatus | undefined): boolean =>
  status?.status === "on" && status.openMove !== null;

export function treasuryStatusQuery(api: ApiClient, organizationId: string) {
  return queryOptions({
    queryKey: treasuryKeys.status(organizationId),
    queryFn: () => api.get(treasuryPath(organizationId), treasuryStatusSchema),
    refetchInterval: (query) =>
      hasOpenMove(query.state.data) ? OPEN_MOVE_POLL_MS : false,
  });
}

/**
 * The API moves the wallet's ledger partway through a move and Treasury's
 * value at another point, so while a move is open the wallet is asked about
 * with every Treasury answer, and once it ends everything is asked again
 * once. Otherwise the page shows the same money in both accounts.
 */
export function followTreasuryMoves(
  queryClient: QueryClient,
  organizationId: string,
): () => void {
  const statusKey = treasuryKeys.status(organizationId);
  let moveWasOpen = hasOpenMove(
    queryClient.getQueryData<TreasuryStatus>(statusKey),
  );
  return queryClient.getQueryCache().subscribe((event) => {
    const { query } = event;
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      !matchQuery({ queryKey: statusKey, exact: true }, query)
    ) {
      return;
    }
    const moveIsOpen = hasOpenMove(query.state.data as TreasuryStatus);
    if (moveIsOpen) {
      void queryClient.invalidateQueries({
        queryKey: walletKeys.summary(organizationId),
      });
      void queryClient.invalidateQueries({
        queryKey: walletKeys.history(organizationId),
      });
    } else if (moveWasOpen) {
      void queryClient.invalidateQueries({
        queryKey: walletKeys.all(organizationId),
      });
    }
    moveWasOpen = moveIsOpen;
  });
}

export function useTreasury(
  organizationId: string,
): UseQueryResult<TreasuryStatus> {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(
    () => followTreasuryMoves(queryClient, organizationId),
    [queryClient, organizationId],
  );
  return useQuery(treasuryStatusQuery(api, organizationId));
}

export function useTreasuryMoves(
  organizationId: string,
  enabled: boolean,
): UseQueryResult<TreasuryMoveSummary[]> {
  const api = useApi();
  return useQuery({
    queryKey: treasuryKeys.moves(organizationId),
    queryFn: async () =>
      (
        await api.get(
          `${treasuryPath(organizationId)}/moves`,
          treasuryMoveListSchema,
        )
      ).moves,
    enabled,
  });
}

/**
 * What a move would cost and take, asked about while the admin types. A
 * refusal (too small, more than there is, one already open, paused) is the
 * query's error and carries the API's own words.
 */
export function useMovePreview(
  organizationId: string,
  request: TreasuryMoveRequest | null,
): UseQueryResult<TreasuryMovePreview> {
  const api = useApi();
  return useQuery({
    queryKey: request
      ? treasuryKeys.preview(
          organizationId,
          request.direction,
          request.amountUsdc,
        )
      : [...treasuryKeys.status(organizationId), "preview", "idle"],
    queryFn: () =>
      request
        ? api.post(
            `${treasuryPath(organizationId)}/moves/preview`,
            request,
            treasuryMovePreviewSchema,
          )
        : Promise.reject(new Error("No move to preview")),
    enabled: request !== null,
    retry: false,
    gcTime: 60_000,
  });
}

/** Turn on: the passkey challenge, then the signed confirmation. */
export function turnOnSteps(api: ApiClient, organizationId: string) {
  const path = treasuryPath(organizationId);
  return {
    request: (): Promise<ApprovalChallenge> =>
      api.post(
        `/organizations/${organizationId}/treasury/confirmations`,
        undefined,
        turnOnTreasuryChallengeSchema,
      ),
    confirm: (challenge: ApprovalChallenge, response: PasskeyAssertion) =>
      api.post(
        path,
        { challengeId: challenge.challengeId, response },
        treasuryStatusSchema,
      ),
  };
}

/** A move: the challenge bound to its direction and amount, then the signed start. */
export function moveSteps(api: ApiClient, organizationId: string) {
  const path = `/organizations/${organizationId}/treasury/moves` as const;
  return {
    request: (request: TreasuryMoveRequest): Promise<ApprovalChallenge> =>
      api.post(`${path}/confirmations`, request, treasuryMoveChallengeSchema),
    confirm: (
      challenge: ApprovalChallenge,
      response: PasskeyAssertion,
      request: TreasuryMoveRequest,
    ) =>
      api.post(
        path,
        {
          direction: request.direction,
          amountUsdc: request.amountUsdc,
          challengeId: challenge.challengeId,
          response,
        },
        treasuryMoveSchema,
      ),
  };
}

type MoveChallenge = ApprovalChallenge & {
  readonly request: TreasuryMoveRequest;
};

export function useTurnOnTreasury(
  organizationId: string,
): UseMutationResult<ApprovalOutcome<TreasuryStatus>, Error, void> {
  const api = useApi();
  const queryClient = useQueryClient();
  const steps = turnOnSteps(api, organizationId);
  return usePasskeyApproval<void, ApprovalChallenge, TreasuryStatus>({
    request: steps.request,
    confirm: steps.confirm,
    onApproved: () =>
      queryClient.invalidateQueries({
        queryKey: walletKeys.all(organizationId),
      }),
  });
}

export function useStartTreasuryMove(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<TreasuryMoveSummary>,
  Error,
  TreasuryMoveRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  const steps = moveSteps(api, organizationId);
  return usePasskeyApproval<
    TreasuryMoveRequest,
    MoveChallenge,
    TreasuryMoveSummary
  >({
    request: async (request) => ({
      ...(await steps.request(request)),
      request,
    }),
    confirm: (challenge, response) =>
      steps.confirm(challenge, response, challenge.request),
    onApproved: () =>
      queryClient.invalidateQueries({
        queryKey: walletKeys.all(organizationId),
      }),
  });
}
