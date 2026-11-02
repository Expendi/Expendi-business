import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type { Claim } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { ClaimStatusBadge } from "~/features/claims/claim-status";
import { WarningBadges } from "~/features/claims/claim-warnings";
import { CompanyPinCard } from "~/features/claims/company-pin-card";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireCompany } from "~/features/claims/require-company";
import { useClaimList } from "~/features/claims/use-claims";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function ClaimsRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <ClaimsScreen company={company} />}
    </RequireCompany>
  );
}

function ClaimsScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const claims = useClaimList(company.organizationId);
  const isAdmin = company.role === "admin";
  const items = claims.data?.pages.flatMap((page) => page.claims) ?? [];

  return (
    <Screen
      belowHeader
      refreshing={claims.isRefetching && !claims.isFetchingNextPage}
      onRefresh={() => void claims.refetch()}
    >
      <Button label="New claim" onPress={() => router.push("/claims/new")} />
      <CompanyPinCard organizationId={company.organizationId} />

      {claims.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading claims" />
      ) : claims.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(claims.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={claims.isFetching}
            onPress={() => void claims.refetch()}
          />
        </View>
      ) : items.length === 0 ? (
        <Text className="text-base text-gray-600">
          {isAdmin
            ? "No one in the company has submitted a claim yet."
            : "You haven’t submitted a claim yet. Paid for something for work? Add it here to get paid back to M-Pesa."}
        </Text>
      ) : (
        <View className="gap-3">
          {items.map((claim) => (
            <ClaimRow
              key={claim.id}
              claim={claim}
              showSubmitter={isAdmin}
              onPress={() =>
                router.push({
                  pathname: "/claims/[claimId]",
                  params: { claimId: claim.id },
                })
              }
            />
          ))}
          {claims.hasNextPage ? (
            <Button
              label="Show more"
              variant="secondary"
              loading={claims.isFetchingNextPage}
              onPress={() => void claims.fetchNextPage()}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function ClaimRow({
  claim,
  showSubmitter,
  onPress,
}: {
  claim: Claim;
  showSubmitter: boolean;
  onPress: () => void;
}): JSX.Element {
  const amount = `KES ${formatKesCents(claim.amountKes)}`;
  const submitter = claim.submittedBy.name ?? claim.submittedBy.email;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${claim.merchant}, ${amount}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {claim.merchant}
          </Text>
          <Text className="text-sm text-gray-600">
            {showSubmitter ? `${submitter} · ` : ""}
            {formatIsoDate(claim.spentOn)}
          </Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">{amount}</Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <ClaimStatusBadge status={claim.status} />
        <WarningBadges warnings={claim.warnings} />
      </View>
    </Pressable>
  );
}
