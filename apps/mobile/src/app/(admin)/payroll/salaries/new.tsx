import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";

import type { Company } from "~/features/company/company-provider";
import { Screen } from "~/components/screen";
import { localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { blankSalaryDraft } from "~/features/payroll/payroll-display";
import { SalaryForm } from "~/features/payroll/salary-form";
import { useCreateSalary } from "~/features/payroll/use-payroll";

export default function NewSalaryRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <NewSalaryScreen company={company} />}
    </RequireAdmin>
  );
}

function NewSalaryScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const create = useCreateSalary(company.organizationId);
  const [today] = useState(() => localIsoDate(new Date()));

  return (
    <Screen belowHeader>
      <SalaryForm
        organizationId={company.organizationId}
        initialDraft={blankSalaryDraft(today)}
        submitLabel="Put on payroll"
        submitting={create.isPending}
        submitError={create.error}
        onSubmit={(request) =>
          create.mutate(request, {
            onSuccess: (salary) =>
              router.replace({
                pathname: "/payroll/salaries/[salaryId]",
                params: { salaryId: salary.id },
              }),
          })
        }
      />
    </Screen>
  );
}
