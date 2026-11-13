"use client";

import { useQuery } from "@tanstack/react-query";

import { PageError, PageLoading } from "~/components/page-state";
import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { CardSimulationFlow } from "./card-simulation-flow";
import { CardSimulationsView } from "./card-simulations-view";

export const SANDBOX_NOTE =
  "No real merchant can charge a sandbox card, so here Expendi pretends to be the merchant, as a daily job also does on each bill's due date. This exists only in the sandbox and goes when real merchants charge real cards. The company never sees who made the purchase.";

/** The company page's sandbox merchant section (spec §6.25); its own query, like Treasury. */
export function CardSimulationsSection({
  companyId,
  canAct,
}: {
  companyId: string;
  canAct: boolean;
}) {
  const { api } = useStaffAuth();
  const result = useQuery({
    queryKey: queryKeys.companyCardSimulations(companyId),
    queryFn: () => api.ops.cardSimulations(companyId),
  });

  return (
    <Card className="mt-6 gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>
          <h2>Company-held cards (sandbox)</h2>
        </CardTitle>
      </CardHeader>
      <div className="px-4 pt-4 text-sm sm:px-6">
        <p>{SANDBOX_NOTE}</p>
        {canAct ? null : (
          <p className="mt-2 text-muted-foreground">
            Simulating a purchase needs an ops admin.
          </p>
        )}
      </div>
      {result.isPending ? (
        <div className="px-4 pb-4 sm:px-6">
          <PageLoading label="Loading company-held cards…" />
        </div>
      ) : result.isError ? (
        <div className="px-4 pb-4 sm:px-6">
          <PageError>{describeApiError(result.error)}</PageError>
        </div>
      ) : (
        <CardSimulationsView
          simulations={result.data}
          renderAction={(payment) =>
            canAct && payment.card.state !== "closed" ? (
              <CardSimulationFlow
                organizationId={companyId}
                payment={payment}
              />
            ) : null
          }
        />
      )}
    </Card>
  );
}
