import type { JSX, ReactNode } from "react";
import { PrivyProvider, useLoginWithEmail, usePrivy } from "@privy-io/expo";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * `offering-passkey` means signed in with an email code and being offered a
 * passkey for later launches (spec §4) before reaching the app.
 */
export type AuthStatus =
  "loading" | "signed-out" | "offering-passkey" | "signed-in";

/** Work that needs the session, done as the person signs out, e.g. unregistering push. */
export type SignOutTask = () => Promise<void>;

interface AuthContextValue {
  status: AuthStatus;
  privyUserId: string | null;
  verifyEmailCode: (input: { email: string; code: string }) => Promise<void>;
  finishPasskeyOffer: () => void;
  signOut: () => Promise<void>;
  /** Runs `task` at sign-out, before the session ends; returns how to stop. */
  addSignOutTask: (task: SignOutTask) => () => void;
}

/** A slow network can't keep someone from signing out. */
const SIGN_OUT_TASK_TIMEOUT_MS = 5_000;

function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function runSignOutTasks(tasks: readonly SignOutTask[]): Promise<void> {
  const results = await Promise.allSettled(
    tasks.map((task) => settleWithin(task(), SIGN_OUT_TASK_TIMEOUT_MS)),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[auth] a sign-out step failed", result.reason);
    }
  }
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
  const signOutTasks = useRef(new Set<SignOutTask>());

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

  const addSignOutTask = useCallback((task: SignOutTask) => {
    signOutTasks.current.add(task);
    return () => {
      signOutTasks.current.delete(task);
    };
  }, []);

  const signOut = useCallback(async () => {
    setPasskeyOffer(NO_OFFER);
    await runSignOutTasks([...signOutTasks.current]);
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
      addSignOutTask,
    }),
    [
      status,
      privyUserId,
      verifyEmailCode,
      finishPasskeyOffer,
      signOut,
      addSignOutTask,
    ],
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
