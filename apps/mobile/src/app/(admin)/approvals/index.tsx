import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type { Claim, ExpenseStatus } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { WarningBadges } from "~/features/claims/claim-warnings";
import { formatIsoDate } from "~/features/claims/dates";
import { useClaimQueue } from "~/features/claims/use-claim-approval";
import { RequireAdmin } from "~/features/company/require-admin";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function ApprovalsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <ApprovalsScreen company={company} />}
    </RequireAdmin>
  );
}

/** The admin's queue (spec §6.7): claims to approve, and failed payments to retry. */
function ApprovalsScreen({ company }: { company: Company }): JSX.Element {
  const waiting = useClaimQueue(company.organizationId, "submitted");
  const failed = useClaimQueue(company.organizationId, "payout_failed");

  return (
    <Screen
      belowHeader
      refreshing={
        (waiting.isRefetching && !waiting.isFetchingNextPage) ||
        (failed.isRefetching && !failed.isFetchingNextPage)
      }
      onRefresh={() => {
        void waiting.refetch();
        void failed.refetch();
      }}
    >
      <QueueSection
        title="Waiting for approval"
        empty="Nothing to approve. New claims show up here."
        status="submitted"
        queue={waiting}
      />
      <QueueSection
        title="Payment failed"
        empty={null}
        status="payout_failed"
        queue={failed}
      />
    </Screen>
  );
}

function QueueSection({
  title,
  empty,
  status,
  queue,
}: {
  title: string;
  /** Null hides the section while it's empty. */
  empty: string | null;
  status: ExpenseStatus;
  queue: ReturnType<typeof useClaimQueue>;
}): JSX.Element | null {
  const router = useRouter();
  const claims = queue.data?.pages.flatMap((page) => page.claims) ?? [];

  if (queue.isSuccess && claims.length === 0 && empty === null) return null;

  return (
    <View className="gap-3">
      <Text
        accessibilityRole="header"
        className="text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        {title}
      </Text>
      {queue.isPending ? (
        <ActivityIndicator accessibilityLabel={`Loading: ${title}`} />
      ) : queue.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(queue.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={queue.isFetching}
            onPress={() => void queue.refetch()}
          />
        </View>
      ) : claims.length === 0 ? (
        <Text className="text-base text-gray-600">{empty}</Text>
      ) : (
        <View className="gap-3">
          {claims.map((claim) => (
            <QueueRow
              key={claim.id}
              claim={claim}
              failed={status === "payout_failed"}
              onPress={() =>
                router.push({
                  pathname: "/claims/[claimId]",
                  params: { claimId: claim.id },
                })
              }
            />
          ))}
          {queue.hasNextPage ? (
            <Button
              label="Show more"
              variant="secondary"
              loading={queue.isFetchingNextPage}
              onPress={() => void queue.fetchNextPage()}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

function QueueRow({
  claim,
  failed,
  onPress,
}: {
  claim: Claim;
  failed: boolean;
  onPress: () => void;
}): JSX.Element {
  const amount = `KES ${formatKesCents(claim.amountKes)}`;
  const claimant = claim.submittedBy.name ?? claim.submittedBy.email;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${claimant}, ${claim.merchant}, ${amount}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {claimant}
          </Text>
          <Text className="text-sm text-gray-600">
            {claim.merchant} · {formatIsoDate(claim.spentOn)}
          </Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">{amount}</Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        {failed ? <Badge label="Payment failed" tone="warning" /> : null}
        {!failed && !claim.submittedBy.payoutPhoneConfirmed ? (
          <Badge label="No payout number yet" tone="warning" />
        ) : null}
        <WarningBadges warnings={claim.warnings} />
      </View>
    </Pressable>
  );
}
