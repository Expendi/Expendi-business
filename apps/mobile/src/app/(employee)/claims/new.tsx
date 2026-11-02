import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";

import type { Company } from "~/features/company/company-provider";
import { Screen } from "~/components/screen";
import { ClaimEditor } from "~/features/claims/claim-editor";
import { CompanyPinCard } from "~/features/claims/company-pin-card";
import { localIsoDate } from "~/features/claims/dates";
import { RequireCompany } from "~/features/claims/require-company";
import { useSubmitClaim } from "~/features/claims/use-claims";

export default function NewClaimRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <NewClaimScreen company={company} />}
    </RequireCompany>
  );
}

function NewClaimScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const submit = useSubmitClaim(company.organizationId);
  const [today] = useState(() => localIsoDate(new Date()));

  return (
    <Screen belowHeader>
      <ClaimEditor
        organizationId={company.organizationId}
        initialDraft={{
          merchant: "",
          amount: "",
          spentOn: today,
          categoryId: null,
          description: "",
          mpesaCode: "",
          etimsInvoiceNumber: "",
          etimsSupplierPin: "",
          etimsQrPayload: null,
        }}
        intro={<CompanyPinCard organizationId={company.organizationId} />}
        submitLabel="Submit claim"
        submitting={submit.isPending}
        submitError={submit.error}
        onSubmit={(request) =>
          submit.mutate(request, {
            onSuccess: (claim) =>
              router.replace({
                pathname: "/claims/[claimId]",
                params: { claimId: claim.id },
              }),
          })
        }
      />
    </Screen>
  );
}
