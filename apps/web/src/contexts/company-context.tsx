"use client";

import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import type { MembershipRole, MeResponse } from "@expendi-business/shared";

import { ApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import {
  readSelectedCompanyId,
  saveSelectedCompanyId,
} from "~/lib/selected-company";
import { SESSION_ENDED, useAuth } from "./auth-context";

export interface Company {
  organizationId: string;
  name: string;
  role: MembershipRole;
}

/**
 * - `no-company`: no active membership anywhere.
 * - `choose`: several companies and none picked yet in this browser, or
 *   the person asked to switch (`currentId` is the one they're in).
 */
export type CompanyState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "no-company"; me: MeResponse }
  | {
      status: "choose";
      me: MeResponse;
      companies: Company[];
      currentId: string | null;
    }
  | { status: "ready"; me: MeResponse; companies: Company[]; company: Company };

interface CompanyContextValue {
  state: CompanyState;
  selectCompany: (organizationId: string) => void;
  /** Opens the picker again; `cancelSwitch` goes back to the current company. */
  switchCompany: () => void;
  cancelSwitch: () => void;
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function deriveCompanyState({
  me,
  meError,
  selectedId,
  switching,
}: {
  me: MeResponse | undefined;
  meError: unknown;
  selectedId: string | null;
  switching: boolean;
}): CompanyState {
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
  if (company && !switching) return { status: "ready", me, companies, company };
  return {
    status: "choose",
    me,
    companies,
    currentId: company?.organizationId ?? null,
  };
}

/**
 * Who the signed-in person is (`GET /me`) and which company they're working
 * in. A person in several companies picks one, the same as in the app, and
 * this browser remembers it.
 */
export function CompanyProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const { status, privyUserId, api, endSession } = useAuth();
  const me = useQuery({
    queryKey: queryKeys.me(privyUserId ?? ""),
    queryFn: async () => {
      try {
        return await api.getMe();
      } catch (error) {
        if (isUnauthorized(error)) await endSession(SESSION_ENDED);
        throw error;
      }
    },
    enabled: status === "signed-in" && privyUserId !== null,
    retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2,
  });

  const userId = me.data?.user.id;
  const storedId = useMemo(
    () => (userId ? readSelectedCompanyId(userId) : null),
    [userId],
  );
  const [chosen, setChosen] = useState<{
    userId: string;
    organizationId: string;
  } | null>(null);
  const [switchingUserId, setSwitchingUserId] = useState<string | null>(null);

  const switching = userId !== undefined && switchingUserId === userId;
  const selectedId =
    chosen && chosen.userId === userId ? chosen.organizationId : storedId;
  const state = useMemo(
    () =>
      deriveCompanyState({
        me: me.data,
        meError: me.error,
        selectedId,
        switching,
      }),
    [me.data, me.error, selectedId, switching],
  );

  const selectCompany = useCallback(
    (organizationId: string) => {
      if (!userId) return;
      setChosen({ userId, organizationId });
      setSwitchingUserId(null);
      saveSelectedCompanyId(userId, organizationId);
    },
    [userId],
  );
  const switchCompany = useCallback(
    () => setSwitchingUserId(userId ?? null),
    [userId],
  );
  const cancelSwitch = useCallback(() => setSwitchingUserId(null), []);

  const { refetch } = me;
  const retry = useCallback(() => void refetch(), [refetch]);

  const value = useMemo<CompanyContextValue>(
    () => ({ state, selectCompany, switchCompany, cancelSwitch, retry }),
    [state, selectCompany, switchCompany, cancelSwitch, retry],
  );

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
