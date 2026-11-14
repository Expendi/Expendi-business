import type { JSX } from "react";
import { useLocalSearchParams } from "expo-router";

import { RequireCompany } from "~/features/claims/require-company";
import { ClaimDetailScreen } from "~/features/review/review-screen";

export default function ClaimRoute(): JSX.Element {
  const { claimId } = useLocalSearchParams<{ claimId: string }>();
  return (
    <RequireCompany>
      {(company) => <ClaimDetailScreen company={company} claimId={claimId} />}
    </RequireCompany>
  );
}
