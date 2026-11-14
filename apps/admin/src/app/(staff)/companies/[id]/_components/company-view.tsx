"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { CompanyDetail } from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageHeader } from "~/components/data/page-header";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { PayoutsTable } from "~/components/payouts-table";
import { secondaryButton } from "~/components/styles";
import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
import { CardSimulationsSection } from "./card-simulations-section";
import { memberColumns } from "./columns";
import { CompanyRail } from "./company-rail";
import { TreasurySection } from "./treasury-section";

/** One company, as the Expendi team sees it (spec §6.15). Read-only except the pause. */
export function CompanyView({ companyId }: { companyId: string }) {
  const { api, staff } = useStaffAuth();
  const canAct = staff?.role === "ops_admin";
  const result = useQuery({
    queryKey: queryKeys.company(companyId),
    queryFn: () => api.ops.company(companyId),
  });

  if (result.isPending) {
    return <PageLoading label="Loading company…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }
  const company = result.data;

  return (
    <section className="max-w-7xl">
      <p className="text-sm">
        <Link
          href="/companies"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          Companies
        </Link>
      </p>
      <div className="mt-2">
        <PageHeader
          title={company.name}
          subtitle={
            <>
              KRA PIN {company.kraPin ?? "not given"} · signed up{" "}
              {formatNairobiTime(company.createdAt)} ·{" "}
              <span className="font-mono text-xs">{company.id}</span>
            </>
          }
        />
      </div>
      <p className="mt-4 flex flex-wrap gap-2 text-sm">
        {canAct ? (
          <Link
            href={`/companies/${company.id}/imports`}
            className={secondaryButton}
          >
            Import spreadsheet
          </Link>
        ) : null}
        <Link
          href={`/payouts?companyId=${company.id}`}
          className={secondaryButton}
        >
          Payouts to review
        </Link>
        <Link
          href={`/audit-log?organizationId=${company.id}`}
          className={secondaryButton}
        >
          Audit log
        </Link>
        <Link
          href={`/companies/${company.id}/zoho`}
          className={secondaryButton}
        >
          Zoho Books
        </Link>
      </p>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_336px] items-start gap-6 max-[1280px]:grid-cols-1">
        <div className="min-w-0 max-[1280px]:order-2">
          <CompanyTabs company={company} canAct={canAct} />
        </div>
        <div className="max-[1280px]:order-1">
          <CompanyRail company={company} canAct={canAct} />
        </div>
      </div>
    </section>
  );
}

const COMPANY_TABS = [
  { value: "members", label: "Members" },
  { value: "treasury", label: "Treasury" },
  { value: "cards", label: "Company-held cards" },
  { value: "payouts", label: "Recent payouts" },
] as const;

type CompanyTab = (typeof COMPANY_TABS)[number]["value"];

function isCompanyTab(value: string | null): value is CompanyTab {
  return COMPANY_TABS.some((tab) => tab.value === value);
}

/** The company's tables, one tab each; the open tab lives in `?tab=` so a reload or shared link keeps it. */
function CompanyTabs({
  company,
  canAct,
}: {
  company: CompanyDetail;
  canAct: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get("tab");
  const active: CompanyTab = isCompanyTab(requested) ? requested : "members";

  function selectTab(value: string) {
    const params = new URLSearchParams(searchParams);
    if (value === "members") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }

  return (
    <Tabs value={active} onValueChange={selectTab} className="gap-4">
      <div className="max-w-full overflow-x-auto">
        <TabsList>
          {COMPANY_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="px-3">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="members">
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>
              <h2>Members</h2>
            </CardTitle>
          </CardHeader>
          {company.members.length === 0 ? (
            <PageEmpty title="No members yet." />
          ) : (
            <MembersTable members={company.members} />
          )}
        </Card>
      </TabsContent>

      <TabsContent value="treasury">
        <TreasurySection companyId={company.id} canAct={canAct} />
      </TabsContent>

      <TabsContent value="cards">
        <CardSimulationsSection companyId={company.id} canAct={canAct} />
      </TabsContent>

      <TabsContent value="payouts">
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>
              <h2>Recent payouts</h2>
            </CardTitle>
          </CardHeader>
          {company.recentPayouts.length === 0 ? (
            <PageEmpty title="No payouts yet." />
          ) : (
            <PayoutsTable payouts={company.recentPayouts} showCompany={false} />
          )}
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function MembersTable({ members }: { members: CompanyDetail["members"] }) {
  const table = useDataTable({
    data: members,
    columns: memberColumns,
    getRowId: (member) => member.id,
    manual: true,
    paginate: false,
  });
  return <DataTable table={table} caption="Company members" />;
}
