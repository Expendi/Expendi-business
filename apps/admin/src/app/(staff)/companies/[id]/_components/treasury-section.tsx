"use client";

import { useQuery } from "@tanstack/react-query";

import { PageError, PageLoading } from "~/components/page-state";
import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { TreasuryActionFlow } from "./treasury-action-flow";
import { TreasuryView } from "./treasury-view";

/** The company page's Treasury section; its own query, so a slow Privy read never holds the page. */
export function TreasurySection({
  companyId,
  canAct,
}: {
  companyId: string;
  canAct: boolean;
}) {
  const { api } = useStaffAuth();
  const result = useQuery({
    queryKey: queryKeys.companyTreasury(companyId),
    queryFn: () => api.ops.companyTreasury(companyId),
  });

  return (
    <Card className="mt-6 gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>
          <h2>Treasury</h2>
        </CardTitle>
      </CardHeader>
      {result.isPending ? (
        <PageLoading label="Loading Treasury…" />
      ) : result.isError ? (
        <div className="px-4 pb-4 sm:px-6">
          <PageError>{describeApiError(result.error)}</PageError>
        </div>
      ) : (
        <TreasuryView
          treasury={result.data}
          renderActions={(move) =>
            canAct && move.action ? (
              <TreasuryActionFlow
                organizationId={companyId}
                move={move}
                action={move.action}
              />
            ) : null
          }
        />
      )}
    </Card>
  );
}
