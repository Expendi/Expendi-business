"use client";

import type { User } from "@privy-io/react-auth";
import type { JSX, ReactNode } from "react";
import { useLogin, useLoginWithPasskey, usePrivy } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import type { ApiClient } from "~/lib/api";
import type { CustomerApi } from "~/lib/customer-api";
import { createApiClient } from "~/lib/api";
import { createCustomerApi } from "~/lib/customer-api";

export const SESSION_ENDED = "Your session ended. Sign in again.";

/**
 * - `signing-in`: Privy has the user; deciding whether to offer a passkey.
 * - `offering-passkey`: signed in with an email code and being offered a
 *   passkey for next time (spec §4) before reaching the dashboard.
 */
export type AuthStatus =
  "loading" | "signed-out" | "signing-in" | "offering-passkey" | "signed-in";

interface AuthContextValue {
  status: AuthStatus;
  privyUserId: string | null;
  /** Why the last session ended, for the sign-in page. */
  notice: string | null;
  api: CustomerApi;
  signInWithEmail: () => void;
  /** Rejects when the browser or Privy refuses the passkey. */
  signInWithPasskey: () => Promise<void>;
  passkeySignInPending: boolean;
  finishPasskeyOffer: () => void;
  signOut: () => Promise<void>;
  endSession: (notice: string) => Promise<void>;
}

type PasskeyOffer =
  | { kind: "none" }
  | { kind: "deciding" }
  | { kind: "open"; privyUserId: string };

const NO_OFFER: PasskeyOffer = { kind: "none" };

const AuthContext = createContext<AuthContextValue | null>(null);

function hasPasskey(user: User): boolean {
  return user.linkedAccounts.some((account) => account.type === "passkey");
}

/**
 * The same Privy app and accounts as the app: an email code, then a passkey.
 * Someone who signs in with a code and has no passkey yet is offered one,
 * which accountants (who have no app) can only set up here.
 */
export function AuthProvider({
  apiUrl,
  children,
}: {
  apiUrl: string;
  children: ReactNode;
}): JSX.Element {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const queryClient = useQueryClient();
  const [offer, setOffer] = useState<PasskeyOffer>(NO_OFFER);
  const [notice, setNotice] = useState<string | null>(null);

  const api = useMemo(
    () =>
      createCustomerApi(createApiClient({ baseUrl: apiUrl, getAccessToken })),
    [apiUrl, getAccessToken],
  );

  const { login } = useLogin({
    onComplete: ({ user: signedIn, wasAlreadyAuthenticated, loginMethod }) => {
      const offerPasskey =
        !wasAlreadyAuthenticated &&
        loginMethod === "email" &&
        !hasPasskey(signedIn);
      setOffer(
        offerPasskey ? { kind: "open", privyUserId: signedIn.id } : NO_OFFER,
      );
    },
    onError: () => setOffer(NO_OFFER),
  });
  const { loginWithPasskey, state: passkeyState } = useLoginWithPasskey();

  const signInWithEmail = useCallback(() => {
    setNotice(null);
    setOffer({ kind: "deciding" });
    login({ loginMethods: ["email"] });
  }, [login]);

  const signInWithPasskey = useCallback(() => {
    setNotice(null);
    setOffer(NO_OFFER);
    return loginWithPasskey();
  }, [loginWithPasskey]);

  const finishPasskeyOffer = useCallback(() => setOffer(NO_OFFER), []);

  const endSession = useCallback(
    async (reason: string | null) => {
      setOffer(NO_OFFER);
      setNotice(reason);
      queryClient.clear();
      await logout();
    },
    [logout, queryClient],
  );
  const signOut = useCallback(() => endSession(null), [endSession]);

  const privyUserId = authenticated ? (user?.id ?? null) : null;
  const status = deriveStatus(ready, privyUserId, offer);
  const passkeySignInPending =
    passkeyState.status === "generating-challenge" ||
    passkeyState.status === "awaiting-passkey" ||
    passkeyState.status === "submitting-response";

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      privyUserId,
      notice,
      api,
      signInWithEmail,
      signInWithPasskey,
      passkeySignInPending,
      finishPasskeyOffer,
      signOut,
      endSession,
    }),
    [
      status,
      privyUserId,
      notice,
      api,
      signInWithEmail,
      signInWithPasskey,
      passkeySignInPending,
      finishPasskeyOffer,
      signOut,
      endSession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function deriveStatus(
  ready: boolean,
  privyUserId: string | null,
  offer: PasskeyOffer,
): AuthStatus {
  if (!ready) return "loading";
  if (privyUserId === null) return "signed-out";
  if (offer.kind === "deciding") return "signing-in";
  if (offer.kind === "open" && offer.privyUserId === privyUserId) {
    return "offering-passkey";
  }
  return "signed-in";
}

/**
 * A session that is always signed in over the given API, with no Privy:
 * the dev preview (`app/dev/preview`) renders pages with sample data in it.
 */
export function StaticAuthProvider({
  api,
  children,
}: {
  api: ApiClient;
  children: ReactNode;
}): JSX.Element {
  const value = useMemo<AuthContextValue>(
    () => ({
      status: "signed-in",
      privyUserId: "preview",
      notice: null,
      api: createCustomerApi(api),
      signInWithEmail: () => undefined,
      signInWithPasskey: () => Promise.resolve(),
      passkeySignInPending: false,
      finishPasskeyOffer: () => undefined,
      signOut: () => Promise.resolve(),
      endSession: () => Promise.resolve(),
    }),
    [api],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
