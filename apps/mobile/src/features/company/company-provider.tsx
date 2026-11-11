import type { JSX, ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import type { MembershipRole, MeResponse } from "@expendi-business/shared";

import { useMe } from "~/features/me/use-me";
import { queryKeys } from "~/lib/query-keys";
import {
  readSelectedCompanyId,
  saveSelectedCompanyId,
} from "~/lib/selected-company";

export interface Company {
  organizationId: string;
  name: string;
  role: MembershipRole;
}

/**
 * - `no-company`: no active membership, so the user is sent to create one.
 * - `choose`: several companies and none remembered on this device.
 */
export type CompanyState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "no-company"; me: MeResponse }
  | { status: "choose"; me: MeResponse; companies: Company[] }
  | {
      status: "ready";
      me: MeResponse;
      companies: Company[];
      company: Company;
    };

export interface CompanyContextValue {
  state: CompanyState;
  selectCompany: (organizationId: string) => void;
  retry: () => void;
}

const CompanyContext = createContext<CompanyContextValue | null>(null);

function activeCompanies(me: MeResponse): Company[] {
  return me.memberships
    .filter((membership) => membership.status === "active")
    .map((membership) => ({
      organizationId: membership.organizationId,
      name: membership.organizationName,
      role: membership.role,
    }));
}

interface CompanyInputs {
  me: MeResponse | undefined;
  meError: unknown;
  selectedId: string | null;
  selectionPending: boolean;
}

function deriveCompanyState({
  me,
  meError,
  selectedId,
  selectionPending,
}: CompanyInputs): CompanyState {
  if (me === undefined) {
    return meError
      ? { status: "error", error: meError }
      : { status: "loading" };
  }

  const companies = activeCompanies(me);
  if (companies.length === 0) return { status: "no-company", me };

  const company =
    companies.find((candidate) => candidate.organizationId === selectedId) ??
    (companies.length === 1 ? companies[0] : undefined);
  if (company) return { status: "ready", me, companies, company };
  if (selectionPending) return { status: "loading" };
  return { status: "choose", me, companies };
}

export function CompanyProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const me = useMe();
  const userId = me.data?.user.id;
  const storedSelection = useQuery({
    queryKey: queryKeys.selectedCompany(userId),
    queryFn: userId ? () => readSelectedCompanyId(userId) : skipToken,
    staleTime: Infinity,
  });
  const [chosen, setChosen] = useState<{
    userId: string;
    organizationId: string;
  } | null>(null);

  const selectedId =
    chosen && chosen.userId === userId
      ? chosen.organizationId
      : (storedSelection.data ?? null);
  const selectionPending = storedSelection.isPending;
  const state = useMemo(
    () =>
      deriveCompanyState({
        me: me.data,
        meError: me.error,
        selectedId,
        selectionPending,
      }),
    [me.data, me.error, selectedId, selectionPending],
  );

  const selectCompany = useCallback(
    (organizationId: string) => {
      if (!userId) return;
      setChosen({ userId, organizationId });
      void saveSelectedCompanyId(userId, organizationId).catch(
        (error: unknown) => {
          console.warn("[company] couldn't remember the selection", error);
        },
      );
    },
    [userId],
  );

  const { refetch } = me;
  const retry = useCallback(() => void refetch(), [refetch]);

  const value = useMemo<CompanyContextValue>(
    () => ({ state, selectCompany, retry }),
    [state, selectCompany, retry],
  );

  return (
    <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
  );
}

/** Supplies a fixed session, e.g. a signed-in admin in dev previews. */
export function StaticCompanyProvider({
  value,
  children,
}: {
  value: CompanyContextValue;
  children: ReactNode;
}): JSX.Element {
  return (
    <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
  );
}

export function useCompanySession(): CompanyContextValue {
  const context = useContext(CompanyContext);
  if (!context) {
    throw new Error("useCompanySession must be used inside CompanyProvider");
  }
  return context;
}
