"use client";

import type { ReactNode } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import type { StaffMeResponse } from "@expendi-business/shared";

import type { InternalApi } from "~/lib/internal-api";
import { ApiError, createApiClient, describeApiError } from "~/lib/api";
import { createInternalApi } from "~/lib/internal-api";
import { queryKeys } from "~/lib/query-keys";

export const NOT_ON_STAFF_LIST = "This email isn't on the Expendi staff list";

/**
 * - `checking`: signed in to Privy, and the API is recording the sign-in or
 *   confirming the staff member.
 * - `unavailable`: the API couldn't be reached; `retry` asks again.
 */
export type StaffAuthStatus =
  "loading" | "signed-out" | "checking" | "unavailable" | "signed-in";

interface StaffAuthContextValue {
  status: StaffAuthStatus;
  staff: StaffMeResponse | null;
  /** Why the last session ended, for the sign-in page. */
  notice: string | null;
  /** Why the staff member couldn't be loaded, when `unavailable`. */
  error: string | null;
  api: InternalApi;
  signIn: () => void;
  signOut: () => Promise<void>;
  retry: () => void;
}

const StaffAuthContext = createContext<StaffAuthContextValue | null>(null);

/** The API refused this login: no token, or not an active staff member. */
function isRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}

function refusalNotice(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return NOT_ON_STAFF_LIST;
  }
  return isRefusal(error)
    ? "Your session ended. Sign in again."
    : describeApiError(error);
}

/**
 * Privy proves the email; the API decides whether it's on the staff list.
 * A fresh sign-in first records itself (`POST /internal/session`, audited),
 * then loads the staff member (`GET /internal/me`). A refusal from either
 * signs out of Privy.
 */
export function StaffAuthProvider({
  apiUrl,
  children,
}: {
  apiUrl: string;
  children: ReactNode;
}) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const queryClient = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const api = useMemo(
    () =>
      createInternalApi(createApiClient({ baseUrl: apiUrl, getAccessToken })),
    [apiUrl, getAccessToken],
  );

  const endSession = useCallback(
    async (reason: string | null) => {
      setSigningIn(false);
      setNotice(reason);
      queryClient.removeQueries({ queryKey: ["internal"] });
      await logout();
    },
    [logout, queryClient],
  );

  const session = useMutation({
    mutationFn: () => api.startSession(),
    onSuccess: () => setSigningIn(false),
    onError: (error) => endSession(refusalNotice(error)),
  });

  const { login } = useLogin({
    onComplete: ({ wasAlreadyAuthenticated }) => {
      if (!wasAlreadyAuthenticated) session.mutate();
    },
    onError: () => setSigningIn(false),
  });

  const privyUserId = user?.id ?? null;
  const me = useQuery({
    queryKey: queryKeys.staffMe(privyUserId ?? ""),
    // A refusal (e.g. the staff member was disabled) ends the session as
    // soon as the API answers.
    queryFn: async () => {
      try {
        return await api.getMe();
      } catch (error) {
        if (isRefusal(error)) await endSession(refusalNotice(error));
        throw error;
      }
    },
    enabled:
      ready &&
      authenticated &&
      privyUserId !== null &&
      !signingIn &&
      !session.isPending,
    retry: (failureCount, error) => !isRefusal(error) && failureCount < 2,
  });

  const signIn = useCallback(() => {
    setNotice(null);
    setSigningIn(true);
    login();
  }, [login]);

  const signOut = useCallback(() => endSession(null), [endSession]);

  const { refetch } = me;
  const retry = useCallback(() => void refetch(), [refetch]);

  const status = deriveStatus({
    ready,
    authenticated,
    recordingSignIn: signingIn || session.isPending,
    staff: me.data,
    error: me.error,
  });
  const value = useMemo<StaffAuthContextValue>(
    () => ({
      status,
      staff: status === "signed-in" ? (me.data ?? null) : null,
      notice,
      error: status === "unavailable" ? describeApiError(me.error) : null,
      api,
      signIn,
      signOut,
      retry,
    }),
    [status, me.data, me.error, notice, api, signIn, signOut, retry],
  );

  return (
    <StaffAuthContext.Provider value={value}>
      {children}
    </StaffAuthContext.Provider>
  );
}

function deriveStatus({
  ready,
  authenticated,
  recordingSignIn,
  staff,
  error,
}: {
  ready: boolean;
  authenticated: boolean;
  recordingSignIn: boolean;
  staff: StaffMeResponse | undefined;
  error: unknown;
}): StaffAuthStatus {
  if (!ready) return "loading";
  if (!authenticated) return "signed-out";
  if (recordingSignIn) return "checking";
  if (staff) return "signed-in";
  if (error && !isRefusal(error)) return "unavailable";
  return "checking";
}

/**
 * A session that is always signed in as the given staff member over the
 * given API, with no Privy: the dev preview (`app/dev/preview`) renders pages
 * with sample data in it.
 */
export function StaticStaffAuthProvider({
  api,
  staff,
  children,
}: {
  api: InternalApi;
  staff: StaffMeResponse;
  children: ReactNode;
}) {
  const value = useMemo<StaffAuthContextValue>(
    () => ({
      status: "signed-in",
      staff,
      notice: null,
      error: null,
      api,
      signIn: () => undefined,
      signOut: () => Promise.resolve(),
      retry: () => undefined,
    }),
    [api, staff],
  );
  return (
    <StaffAuthContext.Provider value={value}>
      {children}
    </StaffAuthContext.Provider>
  );
}

export function useStaffAuth(): StaffAuthContextValue {
  const context = useContext(StaffAuthContext);
  if (!context) {
    throw new Error("useStaffAuth must be used inside StaffAuthProvider");
  }
  return context;
}
