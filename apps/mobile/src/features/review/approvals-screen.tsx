import type { JSX } from "react";
import { Stack, useRouter } from "expo-router";
import { CircleCheck } from "lucide-react-native";
import { View } from "react-native";

import type { ExpenseStatus } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { EmptyState } from "~/components/empty-state";
import { LoadError } from "~/components/load-error";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { localIsoDate } from "~/features/claims/dates";
import { useClaimQueue } from "~/features/claims/use-claim-approval";
import { describeApiError } from "~/lib/api";
import { queueRowView } from "./review-display";
import { ReviewShell } from "./review-shell";

/**
 * The admin's queue (spec §6.7): reimbursements to approve, and failed
 * payments to retry.
 */
export function ApprovalsScreen({
  company,
}: {
  company: Company;
}): JSX.Element {
  const router = useRouter();
  const waiting = useClaimQueue(company.organizationId, "submitted");
  const failed = useClaimQueue(company.organizationId, "payout_failed");

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ReviewShell
        title="Reimbursements"
        onBack={() => {
          router.back();
        }}
        refreshing={
          (waiting.isRefetching && !waiting.isFetchingNextPage) ||
          (failed.isRefetching && !failed.isFetchingNextPage)
        }
        onRefresh={() => {
          void waiting.refetch();
          void failed.refetch();
        }}
      >
        <View className="gap-7">
          <QueueSection
            title="Waiting for approval"
            empty={
              <EmptyState
                icon={CircleCheck}
                title="Nothing to approve"
                message="New reimbursements show up here."
              />
            }
            status="submitted"
            queue={waiting}
          />
          <QueueSection
            title="Payment failed"
            empty={null}
            status="payout_failed"
            queue={failed}
          />
        </View>
      </ReviewShell>
    </>
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
  empty: JSX.Element | null;
  status: ExpenseStatus;
  queue: ReturnType<typeof useClaimQueue>;
}): JSX.Element | null {
  const router = useRouter();
  const claims = queue.data?.pages.flatMap((page) => page.claims) ?? [];
  const today = localIsoDate(new Date());

  if (queue.isSuccess && claims.length === 0 && empty === null) return null;

  return (
    <View>
      <SectionHeader
        title={title}
        count={queue.isSuccess && claims.length > 0 ? claims.length : undefined}
      />
      {queue.isPending ? (
        <SoftGroupSkeleton rows={3} label={`Loading: ${title}`} />
      ) : queue.isError ? (
        <LoadError
          message={describeApiError(queue.error)}
          retrying={queue.isFetching}
          onRetry={() => void queue.refetch()}
        />
      ) : claims.length === 0 ? (
        empty
      ) : (
        <View className="gap-3">
          <SoftGroup>
            {claims.map((claim) => {
              const view = queueRowView(claim, today, status === "payout_failed");
              return (
                <ItemRow
                  key={claim.id}
                  avatarName={view.title}
                  title={view.title}
                  meta={view.meta}
                  metaTone={view.metaTone}
                  amount={view.amount}
                  accessibilityLabel={`${view.title}, ${claim.merchant}, KES ${view.amount}${view.flags.length === 0 ? "" : `, ${view.flags.join(", ")}`}`}
                  onPress={() =>
                    router.push({
                      pathname: "/claims/[claimId]",
                      params: { claimId: claim.id },
                    })
                  }
                />
              );
            })}
          </SoftGroup>
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
