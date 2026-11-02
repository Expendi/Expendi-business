import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";

import type { Company } from "~/features/company/company-provider";
import { Screen } from "~/components/screen";
import { BillForm } from "~/features/bills/bill-form";
import { useCreateBill } from "~/features/bills/use-bills";
import { localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";

export default function NewBillRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <NewBillScreen company={company} />}
    </RequireAdmin>
  );
}

function NewBillScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const create = useCreateBill(company.organizationId);
  const [today] = useState(() => localIsoDate(new Date()));

  return (
    <Screen belowHeader>
      <BillForm
        organizationId={company.organizationId}
        initialDraft={{
          payeeId: null,
          variable: false,
          currency: "kes",
          amount: "",
          dueOn: today,
          heading: null,
          categoryId: null,
          reference: "",
          notes: "",
          adjustmentReason: "",
        }}
        submitLabel="Save bill"
        submitting={create.isPending}
        submitError={create.error}
        onSubmit={(request) =>
          create.mutate(request, {
            onSuccess: (bill) =>
              router.replace({
                pathname: "/bills/[billId]",
                params: { billId: bill.id },
              }),
          })
        }
      />
    </Screen>
  );
}
