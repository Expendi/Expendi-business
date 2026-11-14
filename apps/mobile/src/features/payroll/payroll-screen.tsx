import type { JSX } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Plus,
  SlidersHorizontal,
  Users,
} from "lucide-react-native";
import { useCallback } from "react";
import { Pressable, View } from "react-native";

import type { PayrollRun, Salary } from "@expendi-business/shared";

import type { ItemRowProps } from "~/components/soft-group";
import type { Company } from "~/features/company/company-provider";
import { EmptyState } from "~/components/empty-state";
import { GradientCard, WhiteMark, WhitePill } from "~/components/gradient-card";
import { LoadError } from "~/components/load-error";
import { RoundButton } from "~/components/round-button";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { TabScreen } from "~/components/tab-screen";
import { CappedText, Text } from "~/components/text";
import { formatShortDate, localIsoDate } from "~/features/claims/dates";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { DRAFT_TIMING } from "./payroll-display";
import {
  activeSalaries,
  nextPayDay,
  nextRun,
  pastRuns,
  payoutLabel,
  runRowData,
} from "./payroll-overview";
import { usePayrollRuns, useSalaries } from "./use-payroll";

const PEOPLE_PREVIEW_LIMIT = 4;
const CARD_HEIGHT = 196;

/** The admin's Payroll tab (direction K1): the next run, who is paid, past runs. */
export function PayrollScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const runs = usePayrollRuns(company.organizationId);
  const salaries = useSalaries(company.organizationId);
  const today = localIsoDate(new Date());
  const { refetch: refetchRuns } = runs;
  const { refetch: refetchSalaries } = salaries;

  useFocusEffect(
    useCallback(() => {
      void refetchRuns();
      void refetchSalaries();
    }, [refetchRuns, refetchSalaries]),
  );

  const nothingSetUp =
    runs.isSuccess && salaries.isSuccess && runs.data.length === 0 && salaries.data.length === 0;

  return (
    <TabScreen
      title="Payroll"
      right={
        <RoundButton
          icon={Plus}
          label="Add salary"
          tone="brand"
          onPress={() => router.push("/payroll/salaries/new")}
        />
      }
      refreshing={runs.isRefetching || salaries.isRefetching}
      onRefresh={() => {
        void refetchRuns();
        void refetchSalaries();
      }}
    >
      {nothingSetUp ? (
        <EmptyState
          icon={Users}
          title="No one is on payroll yet"
          message="Set up each person’s net pay and pay day once. Only admins see salaries."
        />
      ) : (
        <>
          <NextRunCard
            runs={runs}
            salaries={salaries.data}
            today={today}
            onRetry={() => void refetchRuns()}
          />
          <View className="mt-7">
            <PeopleSection salaries={salaries} />
          </View>
          <View className="mt-7">
            <PastRunsSection runs={runs} today={today} />
          </View>
        </>
      )}
      <View className="mt-7">
        <SectionHeader title="Settings" />
        <SoftGroup>
          <ItemRow
            title="Payroll cap"
            meta="How far a run can go beyond the salaries set up"
            icon={SlidersHorizontal}
            iconTone="neutral"
            onPress={() => router.push("/payroll/settings")}
          />
        </SoftGroup>
      </View>
    </TabScreen>
  );
}

function NextRunCard({
  runs,
  salaries,
  today,
  onRetry,
}: {
  runs: ReturnType<typeof usePayrollRuns>;
  salaries: readonly Salary[] | undefined;
  today: string;
  onRetry: () => void;
}): JSX.Element {
  if (runs.isPending) {
    return (
      <View
        accessible
        accessibilityLabel="Loading the next payroll run"
        accessibilityState={{ busy: true }}
        className="rounded-[22px] bg-gray-100"
        style={{ height: CARD_HEIGHT }}
      />
    );
  }
  if (runs.isError) {
    return (
      <LoadError
        message={describeApiError(runs.error)}
        retryLabel="Try payroll again"
        retrying={runs.isFetching}
        onRetry={onRetry}
      />
    );
  }
  const run = nextRun(runs.data);
  if (run) return <RunCard run={run} today={today} />;

  const payDay = salaries ? nextPayDay(salaries) : null;
  return (
    <View>
      <GradientCard height={CARD_HEIGHT} vertical>
        <View className="flex-1 justify-between p-5">
          <View className="flex-row items-start justify-between">
            <WhitePill
              label={
                payDay
                  ? `Next pay day · ${formatShortDate(payDay, today)}`
                  : "Next run"
              }
            />
            <WhiteMark size={30} />
          </View>
          <Text className="text-[20px] font-semibold text-white">
            No run drafted yet
          </Text>
        </View>
      </GradientCard>
      <Text className="mt-3 text-[14px] leading-5 text-gray-600">
        {DRAFT_TIMING}
      </Text>
    </View>
  );
}

function RunCard({
  run,
  today,
}: {
  run: PayrollRun;
  today: string;
}): JSX.Element {
  const router = useRouter();
  const people = `${String(run.people)} ${run.people === 1 ? "person" : "people"}`;
  const draft = run.status === "draft";
  const open = (): void =>
    router.push({
      pathname: "/payroll/runs/[runId]",
      params: { runId: run.id },
    });
  return (
    <GradientCard height={CARD_HEIGHT} vertical>
      <View className="flex-1 justify-between p-5">
        <View className="flex-row items-start justify-between">
          <WhitePill
            label={`Next run · ${formatShortDate(run.payDate, today)}`}
          />
          <WhiteMark size={30} />
        </View>
        <View className="flex-row flex-wrap items-end justify-between gap-3">
          <View
            accessible
            accessibilityLabel={`KES ${formatKesCents(run.totalKes)}, ${people}`}
          >
            <CappedText
              size={34}
              lineHeight={40}
              maxScale={1.25}
              className="font-normal tracking-[-0.6px] text-white"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {formatKesCents(run.totalKes)}
            </CappedText>
            <Text className="text-[15px] font-medium text-white">
              KES · {people}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${draft ? "Review" : "Open"} the run for ${formatShortDate(run.payDate, today)}`}
            onPress={open}
            className="h-11 items-center justify-center rounded-full bg-white px-5 active:opacity-80"
          >
            <Text className="text-[15px] font-semibold text-gray-900">
              {draft ? "Review run" : "View run"}
            </Text>
          </Pressable>
        </View>
      </View>
    </GradientCard>
  );
}

function PeopleSection({
  salaries,
}: {
  salaries: ReturnType<typeof useSalaries>;
}): JSX.Element {
  const router = useRouter();
  if (salaries.isPending) {
    return (
      <>
        <SectionHeader title="People" />
        <SoftGroupSkeleton rows={3} label="Loading who is on payroll" />
      </>
    );
  }
  if (salaries.isError) {
    return (
      <>
        <SectionHeader title="People" />
        <LoadError
          message={describeApiError(salaries.error)}
          retryLabel="Try salaries again"
          retrying={salaries.isFetching}
          onRetry={() => void salaries.refetch()}
        />
      </>
    );
  }
  const people = activeSalaries(salaries.data);
  return (
    <>
      <SectionHeader
        title="People"
        count={people.length === 0 ? undefined : people.length}
        action="See all"
        onAction={() => router.push("/payroll/salaries")}
      />
      {people.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No one is being paid"
          message="Every salary is paused or ended. See all to change that."
        />
      ) : (
        <SoftGroup>
          {people.slice(0, PEOPLE_PREVIEW_LIMIT).map((salary) => (
            <ItemRow
              key={salary.id}
              {...salaryRow(salary)}
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
    </>
  );
}

function salaryRow(salary: Salary): ItemRowProps {
  return {
    title: salary.payee.name,
    meta: payoutLabel(salary.payee.method),
    amount: formatKesCents(salary.amountKes),
    avatarName: salary.payee.name,
  };
}

function PastRunsSection({
  runs,
  today,
}: {
  runs: ReturnType<typeof usePayrollRuns>;
  today: string;
}): JSX.Element | null {
  const router = useRouter();
  if (runs.isPending) {
    return (
      <>
        <SectionHeader title="Past runs" />
        <SoftGroupSkeleton rows={2} label="Loading past runs" />
      </>
    );
  }
  if (runs.isError) return null;
  const past = pastRuns(runs.data);
  if (past.length === 0) return null;
  return (
    <>
      <SectionHeader title="Past runs" />
      <SoftGroup>
        {past.map((run) => {
          const row = runRowData(run, today);
          return (
            <ItemRow
              key={run.id}
              title={row.title}
              meta={row.meta}
              metaTone={row.metaTone}
              amount={formatKesCents(run.totalKes)}
              icon={
                row.tone === "positive"
                  ? CircleCheck
                  : row.tone === "negative"
                    ? CircleAlert
                    : Clock
              }
              iconTone={row.tone === "neutral" ? "neutral" : row.tone}
              onPress={() =>
                router.push({
                  pathname: "/payroll/runs/[runId]",
                  params: { runId: run.id },
                })
              }
            />
          );
        })}
      </SoftGroup>
    </>
  );
}
