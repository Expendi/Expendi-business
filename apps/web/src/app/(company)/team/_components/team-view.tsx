"use client";

import type { JSX } from "react";
import {
  CircleCheckIcon,
  FilterXIcon,
  MailIcon,
  SmartphoneIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { InviteMemberResponse, Member } from "@expendi-business/shared";
import { MEMBERSHIP_ROLES } from "@expendi-business/shared";

import type { TeamSortKey, TeamView as View } from "./team-display";
import type { SortState } from "~/components/data/data-table";
import type { KindTab } from "~/components/data/kind-tabs";
import { TextLinkButton } from "~/components/data/actions";
import { Banners } from "~/components/data/banner";
import { EntityMark, Mini } from "~/components/data/cells";
import {
  DataTable,
  DataTableToolbar,
  sortFromTable,
  toSorting,
  useDataTable,
} from "~/components/data/data-table";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { PageHeader } from "~/components/data/page-header";
import { ResultsBody, ResultsPanel } from "~/components/data/results";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { EmptyState, ErrorState } from "~/components/data/states";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { PayoutMini, teamColumns, YouMini } from "./columns";
import {
  InviteBanner,
  InviteSheet,
  MemberSheet,
  MemberStatusBadge,
} from "./member-sheet";
import { useMembers, useMyMembershipId } from "./team-api";
import {
  DEFAULT_TEAM_SORT,
  matchesFilters,
  nameOf,
  PAYOUT_LABELS,
  PAYOUT_STATES,
  readTeamFilters,
  sortMembers,
  TEAM_VIEWS,
  teamStats,
} from "./team-display";

type TeamParam = "view" | "memberRole" | "mpesa" | "memberId";

const ROLE_OPTIONS = MEMBERSHIP_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));

const PAYOUT_OPTIONS = PAYOUT_STATES.map((state) => ({
  value: state,
  label: PAYOUT_LABELS[state],
}));

const NO_MEMBERS: Member[] = [];

const SORT_KEYS: readonly TeamSortKey[] = ["name", "role", "status"];

const EMPTY: Record<View, { title: string; text: string }> = {
  all: {
    title: "No one here yet",
    text: "Invite admins, employees and accountants.",
  },
  active: {
    title: "No one active yet",
    text: "People show here once they first sign in.",
  },
  invited: {
    title: "No open invites",
    text: "People you invite show here until they first sign in.",
  },
};

const CAPTIONS: Record<View, string> = {
  all: "Everyone in the company",
  active: "Active people",
  invited: "Open invites",
};

/**
 * The company's people (spec §6.2, §6.14): admins invite, change roles and
 * remove, accountants included; accountants see the list. The tab, the
 * filters and the open person live in the URL.
 */
export function TeamView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyTeam
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyTeam({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const members = useMembers(organizationId);
  const myId = useMyMembershipId(organizationId);
  const [param, setParams] = useDeepLinkParams<TeamParam>();
  const filters = readTeamFilters(param);
  const openId = param("memberId");
  const [sort, setSort] = useState<SortState<TeamSortKey>>(DEFAULT_TEAM_SORT);
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState<InviteMemberResponse | null>(null);

  const everyone = members.data ?? NO_MEMBERS;
  const rows = sortMembers(
    everyone.filter((member) => matchesFilters(member, filters)),
    sort,
  );
  const ids = rows.map((member) => member.id);
  const openIndex = openId ? ids.indexOf(openId) : -1;
  const openMember = everyone.find((member) => member.id === openId);
  const anyChip = filters.role !== null || filters.mpesa !== null;
  const justMe = everyone.length === 1 && everyone[0]?.id === myId && !anyChip;
  const open = (id: string) => setParams({ memberId: id });
  const clearChips = () => setParams({ memberRole: null, mpesa: null });

  const sorting = useMemo(() => toSorting(sort), [sort]);
  const columns = useMemo(
    () => teamColumns({ myId, onOpen: (id) => setParams({ memberId: id }) }),
    [myId, setParams],
  );
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (member) => member.id,
    manual: true,
    paginate: false,
    sorting: {
      value: sorting,
      onChange: (next) => setSort((now) => sortFromTable(next, now, SORT_KEYS)),
    },
  });

  const inTabs = everyone.filter((member) =>
    matchesFilters(member, filters, true),
  );
  const tabs: readonly KindTab<View>[] = TEAM_VIEWS.map((tab) => ({
    ...tab,
    count: members.isSuccess
      ? tab.value === "all"
        ? inTabs.length
        : inTabs.filter((member) => member.status === tab.value).length
      : undefined,
  }));

  function openInvite() {
    setParams({ memberId: null });
    setInviting(true);
  }

  const inviteButton = (
    <Button size="md" aria-haspopup="dialog" onClick={openInvite}>
      <UserPlusIcon aria-hidden="true" />
      Invite someone
    </Button>
  );

  return (
    <section>
      <PageHeader
        title="Team"
        subtitle={
          canAct
            ? "Invite admins, employees and accountants. Removing someone ends their access; their unpaid reimbursements can still be paid."
            : "Everyone in the company and their role. Only admins change the team."
        }
        actions={canAct && !members.isError ? inviteButton : null}
      />

      <Banners>
        {invited ? (
          <InviteBanner result={invited} onDone={() => setInvited(null)} />
        ) : null}
      </Banners>

      {members.isError ? null : (
        <StatCards columns={3}>
          {members.isSuccess ? (
            <TeamStatCards members={members.data} />
          ) : (
            <>
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </>
          )}
        </StatCards>
      )}

      <ResultsPanel label="Team">
        <DataTableToolbar table={table}>
          <KindTabs
            label="Team"
            tabs={tabs}
            value={filters.view}
            onChange={(view) =>
              setParams({ view: view === "all" ? null : view })
            }
            controls="team-results"
          />
          <FilterChip
            label="Role"
            icon={UserIcon}
            options={ROLE_OPTIONS}
            value={filters.role}
            onChange={(memberRole) => setParams({ memberRole })}
            anyLabel="Any role"
          />
          <FilterChip
            label="M-Pesa number"
            icon={SmartphoneIcon}
            options={PAYOUT_OPTIONS}
            value={filters.mpesa}
            onChange={(mpesa) => setParams({ mpesa })}
            anyLabel="Any"
          />
          {anyChip ? (
            <TextLinkButton onClick={clearChips} className="text-sm">
              Clear all
            </TextLinkButton>
          ) : null}
        </DataTableToolbar>
        <ResultsBody id="team-results" busy={members.isPending}>
          {members.isError ? (
            <ErrorState
              title="The team didn't load"
              onRetry={() => void members.refetch()}
            >
              {describeApiError(members.error)}
            </ErrorState>
          ) : (
            <>
              <DataTable
                table={table}
                caption={
                  members.isPending
                    ? "Loading the team…"
                    : CAPTIONS[filters.view]
                }
                phoneLabel={members.isPending ? "Loading the team" : "Team"}
                loading={members.isPending}
                onRowOpen={(member) => open(member.id)}
                openRowId={openId}
                empty={
                  anyChip ? (
                    <EmptyState
                      icon={FilterXIcon}
                      title="No one matches these filters"
                      action={
                        <Button
                          variant="outline"
                          size="md"
                          onClick={clearChips}
                        >
                          Clear all
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={filters.view === "invited" ? MailIcon : UsersIcon}
                      title={EMPTY[filters.view].title}
                      action={canAct ? inviteButton : null}
                    >
                      {EMPTY[filters.view].text}
                    </EmptyState>
                  )
                }
                renderPhoneCard={(row) => (
                  <MemberCard
                    key={row.id}
                    member={row.original}
                    isMe={row.id === myId}
                    onOpen={() => open(row.id)}
                  />
                )}
              />
              {justMe ? (
                <div className="border-t border-border">
                  <EmptyState
                    icon={UserPlusIcon}
                    title="Just you so far"
                    action={canAct ? inviteButton : null}
                  >
                    {canAct
                      ? "Invite admins, employees and accountants. Each gets an email with a link to join."
                      : "Only admins change the team."}
                  </EmptyState>
                </div>
              ) : null}
            </>
          )}
        </ResultsBody>
      </ResultsPanel>

      <MemberSheet
        organizationId={organizationId}
        member={openMember}
        canAct={canAct}
        isMe={openMember?.id === myId}
        stepper={{
          index: openIndex,
          total: ids.length,
          onStep: (delta) => {
            const next = ids[openIndex + delta];
            if (next) open(next);
          },
          previousLabel: "Previous person",
          nextLabel: "Next person",
        }}
        onClose={() => setParams({ memberId: null })}
      />
      {canAct ? (
        <InviteSheet
          organizationId={organizationId}
          open={inviting}
          onClose={() => setInviting(false)}
          onInvited={(result) => {
            setInvited(result);
            setInviting(false);
            setParams({ view: null, memberRole: null, mpesa: null });
          }}
        />
      ) : null}
    </section>
  );
}

function TeamStatCards({ members }: { members: Member[] }): JSX.Element {
  const stats = teamStats(members, new Date());
  return (
    <>
      <StatCard
        icon={UsersIcon}
        tone="total"
        label="Active"
        value={stats.active}
        sub={stats.breakdown}
      />
      <StatCard
        icon={stats.invited > 0 ? MailIcon : CircleCheckIcon}
        tone={stats.invited > 0 ? "attention" : "clear"}
        label="Invited"
        value={stats.invited}
        sub={stats.oldestInvite ?? "No open invites"}
      />
      <StatCard
        icon={stats.withoutPayout > 0 ? SmartphoneIcon : CircleCheckIcon}
        tone={stats.withoutPayout > 0 ? "attention" : "clear"}
        label="No M-Pesa number yet"
        value={stats.withoutPayout}
        sub={
          stats.withoutPayout > 0
            ? "Can't be paid until they confirm it"
            : "Everyone can be paid"
        }
      />
    </>
  );
}

function MemberCard({
  member,
  isMe,
  onOpen,
}: {
  member: Member;
  isMe: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <li className="flex items-start border-b border-border">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 border-0 bg-transparent px-4 py-3.5 text-left focus-visible:-outline-offset-2"
      >
        <EntityMark name={nameOf(member)} kind="person" />
        <span className="min-w-0">
          <span className="block truncate text-base leading-6 font-(--w-name) text-foreground">
            {member.name ?? "No name yet"}
          </span>
          <span className="block truncate text-muted-foreground tabular-nums">
            {member.email}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1">
            <Mini icon={UserIcon} label={`Role: ${ROLE_LABELS[member.role]}`}>
              {ROLE_LABELS[member.role]}
            </Mini>
            <PayoutMini member={member} />
            {isMe ? <YouMini /> : null}
          </span>
        </span>
        <MemberStatusBadge member={member} />
      </button>
    </li>
  );
}
