import type { JSX, ReactNode } from "react";
import { PrivyProvider, useLoginWithEmail, usePrivy } from "@privy-io/expo";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * `offering-passkey` means signed in with an email code and being offered a
 * passkey for later launches (spec §4) before reaching the app.
 */
export type AuthStatus =
  "loading" | "signed-out" | "offering-passkey" | "signed-in";

interface AuthContextValue {
  status: AuthStatus;
  privyUserId: string | null;
  verifyEmailCode: (input: { email: string; code: string }) => Promise<void>;
  finishPasskeyOffer: () => void;
  signOut: () => Promise<void>;
}

type PasskeyOffer =
  | { kind: "none" }
  | { kind: "verifying-code" }
  | { kind: "open"; privyUserId: string };

const NO_OFFER: PasskeyOffer = { kind: "none" };

const AuthContext = createContext<AuthContextValue | null>(null);

function AuthSession({ children }: { children: ReactNode }): JSX.Element {
  const { user, isReady, logout } = usePrivy();
  const { loginWithCode } = useLoginWithEmail();
  const queryClient = useQueryClient();
  const [passkeyOffer, setPasskeyOffer] = useState<PasskeyOffer>(NO_OFFER);

  const verifyEmailCode = useCallback(
    async ({ email, code }: { email: string; code: string }) => {
      setPasskeyOffer({ kind: "verifying-code" });
      try {
        const signedInUser = await loginWithCode({ email, code });
        setPasskeyOffer(
          signedInUser
            ? { kind: "open", privyUserId: signedInUser.id }
            : NO_OFFER,
        );
      } catch (error) {
        setPasskeyOffer(NO_OFFER);
        throw error;
      }
    },
    [loginWithCode],
  );

  const finishPasskeyOffer = useCallback(() => setPasskeyOffer(NO_OFFER), []);

  const signOut = useCallback(async () => {
    setPasskeyOffer(NO_OFFER);
    await logout();
    queryClient.clear();
  }, [logout, queryClient]);

  const privyUserId = user?.id ?? null;
  const status = deriveStatus(isReady, privyUserId, passkeyOffer);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      privyUserId,
      verifyEmailCode,
      finishPasskeyOffer,
      signOut,
    }),
    [status, privyUserId, verifyEmailCode, finishPasskeyOffer, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function deriveStatus(
  isReady: boolean,
  privyUserId: string | null,
  passkeyOffer: PasskeyOffer,
): AuthStatus {
  if (!isReady) return "loading";
  if (privyUserId === null) return "signed-out";
  if (passkeyOffer.kind === "verifying-code") return "offering-passkey";
  if (
    passkeyOffer.kind === "open" &&
    passkeyOffer.privyUserId === privyUserId
  ) {
    return "offering-passkey";
  }
  return "signed-in";
}

interface AuthProviderProps {
  privyAppId: string;
  privyClientId: string;
  children: ReactNode;
}

export function AuthProvider({
  privyAppId,
  privyClientId,
  children,
}: AuthProviderProps): JSX.Element {
  return (
    <PrivyProvider
      appId={privyAppId}
      clientId={privyClientId}
      config={{
        embedded: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
      }}
    >
      <AuthSession>{children}</AuthSession>
    </PrivyProvider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
