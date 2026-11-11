import type { JSX } from "react";
import { Stack, useRouter } from "expo-router";
import { Plus, ReceiptText } from "lucide-react-native";
import { RefreshControl, ScrollView, View } from "react-native";

import type { Claim } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { DetailHeader } from "~/components/detail-header";
import { EmptyState } from "~/components/empty-state";
import { LoadError } from "~/components/load-error";
import { RoundButton } from "~/components/round-button";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { WarningBadges } from "~/features/claims/claim-warnings";
import { CompanyPinCard } from "~/features/claims/company-pin-card";
import { localIsoDate } from "~/features/claims/dates";
import { reimbursementRow } from "~/features/claims/reimbursement-row";
import { RequireCompany } from "~/features/claims/require-company";
import { useClaimList } from "~/features/claims/use-claims";
import { describeApiError } from "~/lib/api";
import { colors } from "~/theme/colors";

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
  const today = localIsoDate(new Date());

  return (
    <View className="flex-1 bg-white">
      <Stack.Screen options={{ headerShown: false }} />
      <DetailHeader
        title="Reimbursements"
        onBack={() => router.back()}
        right={
          <RoundButton
            icon={Plus}
            label="New reimbursement"
            tone="brand"
            onPress={() => router.push("/claims/new")}
          />
        }
      />
      <ScrollView
        contentContainerClassName="mx-auto w-full max-w-3xl gap-5 px-5 pb-10 pt-4"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={claims.isRefetching && !claims.isFetchingNextPage}
            onRefresh={() => void claims.refetch()}
            tintColor={colors.brandStrong}
            colors={[colors.brandStrong]}
          />
        }
      >
        <CompanyPinCard organizationId={company.organizationId} />

        {claims.isPending ? (
          <SoftGroupSkeleton rows={4} label="Loading reimbursements" />
        ) : claims.isError ? (
          <LoadError
            message={describeApiError(claims.error)}
            retryLabel="Try reimbursements again"
            retrying={claims.isFetching}
            onRetry={() => void claims.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="No reimbursements yet"
            message={
              isAdmin
                ? "No one in the company has submitted a reimbursement yet."
                : "Paid for something for work? Add it here to get paid back to M-Pesa."
            }
          />
        ) : (
          <>
            <SoftGroup>
              {items.map((claim) => (
                <ClaimItem
                  key={claim.id}
                  claim={claim}
                  today={today}
                  showSubmitter={isAdmin}
                  onPress={() =>
                    router.push({
                      pathname: "/claims/[claimId]",
                      params: { claimId: claim.id },
                    })
                  }
                />
              ))}
            </SoftGroup>
            {claims.hasNextPage ? (
              <Button
                label="Show more"
                variant="secondary"
                loading={claims.isFetchingNextPage}
                onPress={() => void claims.fetchNextPage()}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ClaimItem({
  claim,
  today,
  showSubmitter,
  onPress,
}: {
  claim: Claim;
  today: string;
  showSubmitter: boolean;
  onPress: () => void;
}): JSX.Element {
  const submitter = claim.submittedBy.name ?? claim.submittedBy.email;
  return (
    <View>
      <ItemRow
        {...reimbursementRow(
          claim,
          today,
          onPress,
          showSubmitter ? `${submitter} · ` : "",
        )}
      />
      {claim.warnings.length > 0 ? (
        <View className="pb-3 pl-14">
          <WarningBadges warnings={claim.warnings} />
        </View>
      ) : null}
    </View>
  );
}
