import type { JSX } from "react";
import { useRouter } from "expo-router";
import { Users } from "lucide-react-native";

import type { Salary } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { EmptyState } from "~/components/empty-state";
import { LoadError } from "~/components/load-error";
import { Screen } from "~/components/screen";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { formatShortDate, localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { SALARY_STATE_LABELS } from "~/features/payroll/payroll-display";
import { payoutLabel } from "~/features/payroll/payroll-overview";
import { useSalaries } from "~/features/payroll/use-payroll";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function SalariesRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <SalariesScreen company={company} />}
    </RequireAdmin>
  );
}

function SalariesScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const salaries = useSalaries(company.organizationId);

  return (
    <Screen
      belowHeader
      refreshing={salaries.isRefetching}
      onRefresh={() => void salaries.refetch()}
    >
      <Button
        label="New salary"
        onPress={() => router.push("/payroll/salaries/new")}
      />

      {salaries.isPending ? (
        <SoftGroupSkeleton rows={4} label="Loading salaries" />
      ) : salaries.isError ? (
        <LoadError
          message={describeApiError(salaries.error)}
          retrying={salaries.isFetching}
          onRetry={() => void salaries.refetch()}
        />
      ) : salaries.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No salaries yet"
          message="Set up each person’s net pay and pay day once. Only admins see salaries."
        />
      ) : (
        <SoftGroup>
          {salaries.data.map((salary) => (
            <ItemRow
              key={salary.id}
              title={salary.payee.name}
              meta={salaryMeta(salary)}
              metaTone={salary.state === "active" ? "default" : "negative"}
              amount={formatKesCents(salary.amountKes)}
              avatarName={salary.payee.name}
              accessibilityLabel={`${salary.payee.name}, KES ${formatKesCents(salary.amountKes)}, ${salaryMeta(salary)}`}
              onPress={() =>
                router.push({
                  pathname: "/payroll/salaries/[salaryId]",
                  params: { salaryId: salary.id },
                })
              }
            />
          ))}
        </SoftGroup>
      )}
    </Screen>
  );
}

/** Payout method and next pay day; a paused or ended salary says so instead. */
function salaryMeta(salary: Salary): string {
  if (salary.state !== "active") return SALARY_STATE_LABELS[salary.state].label;
  const next = salary.nextPayDate
    ? `next paid ${formatShortDate(salary.nextPayDate, localIsoDate(new Date()))}`
    : "no more pay";
  return `${payoutLabel(salary.payee.method)} · ${next}`;
}
