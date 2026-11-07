"use client";

import type { JSX } from "react";
import { cn } from "cn";
import {
  CircleCheckIcon,
  FilterXIcon,
  MailIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
  UserIcon,
  UserPlusIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import type { InviteMemberResponse, Member } from "@expendi-business/shared";
import { MEMBERSHIP_ROLES } from "@expendi-business/shared";

import type { TeamSortKey, TeamView as View } from "./team-display";
import type { KindTab } from "~/components/data/kind-tabs";
import type { SortState } from "~/components/data/table";
import { Banners } from "~/components/data/banner";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { PageHeader } from "~/components/data/page-header";
import {
  ResultsBody,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import {
  DataRow,
  DataTable,
  EntityMark,
  Mini,
  nextSort,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  SortHeader,
  Td,
  Th,
} from "~/components/data/table";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
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
  payoutOf,
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

  const everyone = members.data ?? [];
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
  const onSort = (key: TeamSortKey) => setSort(nextSort(sort, key, "asc"));

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
        <ResultsHead
          tabs={
            <KindTabs
              label="Team"
              tabs={tabs}
              value={filters.view}
              onChange={(view) =>
                setParams({ view: view === "all" ? null : view })
              }
              controls="team-results"
            />
          }
          chips={
            <>
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
            </>
          }
          onClearAll={anyChip ? clearChips : undefined}
        />
        <ResultsBody id="team-results" busy={members.isPending}>
          {members.isPending ? (
            <TeamSkeleton />
          ) : members.isError ? (
            <ErrorState
              title="The team didn't load"
              onRetry={() => void members.refetch()}
            >
              {describeApiError(members.error)}
            </ErrorState>
          ) : rows.length === 0 ? (
            anyChip ? (
              <EmptyState
                icon={FilterXIcon}
                title="No one matches these filters"
                action={
                  <Button variant="outline" size="md" onClick={clearChips}>
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
          ) : (
            <>
              <DataTable caption={CAPTIONS[filters.view]}>
                <thead>
                  <tr>
                    <SortHeader
                      label="Person"
                      sortKey="name"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Role"
                      sortKey="role"
                      sort={sort}
                      onSort={onSort}
                    />
                    <Th>M-Pesa number</Th>
                    <SortHeader
                      label="Status"
                      sortKey="status"
                      sort={sort}
                      onSort={onSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((member) => (
                    <MemberRow
                      key={member.id}
                      member={member}
                      isMe={member.id === myId}
                      open={member.id === openId}
                      onOpen={() => open(member.id)}
                    />
                  ))}
                </tbody>
              </DataTable>
              <PhoneCards label="Team">
                {rows.map((member) => (
                  <PhoneCard
                    key={member.id}
                    mark={<EntityMark name={nameOf(member)} kind="person" />}
                    title={member.name ?? "No name yet"}
                    sub={member.email}
                    flags={
                      <>
                        <Mini
                          icon={UserIcon}
                          label={`Role: ${ROLE_LABELS[member.role]}`}
                        >
                          {ROLE_LABELS[member.role]}
                        </Mini>
                        <PayoutMini member={member} />
                        {member.id === myId ? <YouMini /> : null}
                      </>
                    }
                    aside={<MemberStatusBadge member={member} />}
                    onOpen={() => open(member.id)}
                  />
                ))}
              </PhoneCards>
              {justMe ? (
                <div className="border-t border-row-divider">
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

function MemberRow({
  member,
  isMe,
  open,
  onOpen,
}: {
  member: Member;
  isMe: boolean;
  open: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <DataRow open={open} onOpen={onOpen}>
      <Td kind="main">
        <span className="flex min-w-0 items-start gap-3">
          <EntityMark name={nameOf(member)} kind="person" />
          <span className="min-w-0">
            <RowTitle onOpen={onOpen}>
              {member.name ?? (
                <span className="text-gray-600">No name yet</span>
              )}
            </RowTitle>
            <RowMeta text={member.email}>{isMe ? <YouMini /> : null}</RowMeta>
          </span>
        </span>
      </Td>
      <Td className="whitespace-nowrap text-gray-600">
        {ROLE_LABELS[member.role]}
      </Td>
      <Td>
        <PayoutCell member={member} />
      </Td>
      <Td>
        <MemberStatusBadge member={member} />
        {member.status === "invited" && member.invitedAt ? (
          <span className="mt-1 block text-xs leading-4 whitespace-nowrap text-gray-500 tabular-nums">
            Sent {formatNairobiDateTime(member.invitedAt)}
          </span>
        ) : null}
      </Td>
    </DataRow>
  );
}

function PayoutCell({ member }: { member: Member }): JSX.Element {
  const state = payoutOf(member);
  const warn = state === "missing" && member.status === "active";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        state === "confirmed"
          ? "text-gray-700"
          : warn
            ? "text-warn-700"
            : "text-gray-500",
      )}
    >
      {state === "confirmed" ? (
        <CircleCheckIcon
          aria-hidden="true"
          className="size-3.5 text-success-700"
        />
      ) : warn ? (
        <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
      ) : null}
      {PAYOUT_LABELS[state]}
    </span>
  );
}

function PayoutMini({ member }: { member: Member }): JSX.Element {
  const state = payoutOf(member);
  return (
    <Mini
      icon={SmartphoneIcon}
      label={`M-Pesa number: ${PAYOUT_LABELS[state].toLowerCase()}`}
      warn={state === "missing" && member.status === "active"}
    >
      {PAYOUT_LABELS[state]}
    </Mini>
  );
}

function YouMini(): JSX.Element {
  return (
    <Mini icon={UserRoundIcon} label="You">
      You
    </Mini>
  );
}

const skeletonCell = "border-b border-row-divider px-4 py-3";

function TeamSkeleton(): JSX.Element {
  return (
    <>
      <DataTable caption="Loading the team…">
        <tbody>
          {Array.from({ length: 6 }, (_, row) => (
            <tr key={row} aria-hidden="true">
              <td className={cn(skeletonCell, "w-full max-w-0")}>
                <span className="flex items-center gap-3">
                  <Skel width={32} height={32} className="rounded-full" />
                  <span className="flex-1">
                    <Skel width="45%" height={14} />
                    <Skel width="30%" height={12} style={{ marginTop: 8 }} />
                  </span>
                </span>
              </td>
              <td className={skeletonCell}>
                <Skel width={72} height={14} />
              </td>
              <td className={skeletonCell}>
                <Skel width={80} height={14} />
              </td>
              <td className={skeletonCell}>
                <Skel width={64} height={20} />
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <PhoneCards label="Loading the team">
        {Array.from({ length: 4 }, (_, row) => (
          <li
            key={row}
            aria-hidden="true"
            className="flex items-center gap-3 border-b border-row-divider p-4"
          >
            <Skel width={32} height={32} className="rounded-full" />
            <span className="flex-1">
              <Skel width="55%" height={14} />
              <Skel width="40%" height={12} style={{ marginTop: 8 }} />
            </span>
          </li>
        ))}
      </PhoneCards>
    </>
  );
}
