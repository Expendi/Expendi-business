import type {
  Member,
  MembershipRole,
  MembershipStatus,
} from "@expendi-business/shared";
import { MEMBERSHIP_ROLES } from "@expendi-business/shared";

import type { SortState } from "~/components/data/data-table";
import type { StatusTone } from "~/components/data/status-badge";
import { ROLE_LABELS } from "~/config/roles";

/** What each role can do (spec §4), as the app words it. */
export const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  admin: "Approves and pays reimbursements, and manages the wallet and team.",
  employee:
    "Submits their own reimbursements in the app and gets paid to M-Pesa.",
  accountant:
    "View-only access to this dashboard, plus monthly exports by email.",
};

export const MEMBER_STATUS: Record<
  Exclude<MembershipStatus, "removed">,
  { readonly label: string; readonly tone: StatusTone }
> = {
  active: { label: "Active", tone: "quiet" },
  invited: { label: "Invited", tone: "waiting" },
};

export function memberStatus(member: Member): {
  readonly label: string;
  readonly tone: StatusTone;
} {
  return member.status === "invited"
    ? MEMBER_STATUS.invited
    : MEMBER_STATUS.active;
}

/** Whether Expendi can pay them; the number itself is never shown. */
export type PayoutState = "confirmed" | "missing" | "none";

export const PAYOUT_LABELS: Record<PayoutState, string> = {
  confirmed: "Confirmed",
  missing: "Not yet",
  none: "Not needed",
};

export const payoutOf = (member: Member): PayoutState =>
  member.role === "accountant"
    ? "none"
    : member.payoutPhoneConfirmed
      ? "confirmed"
      : "missing";

export const nameOf = (member: Member): string => member.name ?? member.email;

export type TeamView = "all" | "active" | "invited";

export const TEAM_VIEWS: readonly { value: TeamView; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "active", label: "Active" },
  { value: "invited", label: "Invited" },
];

export interface TeamFilters {
  readonly view: TeamView;
  readonly role: MembershipRole | null;
  readonly mpesa: PayoutState | null;
}

const isOneOf = <T extends string>(
  values: readonly T[],
  value: string | null,
): value is T =>
  value !== null && (values as readonly string[]).includes(value);

export const PAYOUT_STATES: readonly PayoutState[] = [
  "confirmed",
  "missing",
  "none",
];
const VIEW_VALUES = TEAM_VIEWS.map((view) => view.value);

/**
 * The filters in the URL; anything unknown is left off. The role filter is
 * `memberRole`, so it never reads as the viewer's own role.
 */
export function readTeamFilters(
  read: (name: "view" | "memberRole" | "mpesa") => string | null,
): TeamFilters {
  const view = read("view");
  const role = read("memberRole");
  const mpesa = read("mpesa");
  return {
    view: isOneOf(VIEW_VALUES, view) ? view : "all",
    role: isOneOf(MEMBERSHIP_ROLES, role) ? role : null,
    mpesa: isOneOf(PAYOUT_STATES, mpesa) ? mpesa : null,
  };
}

/** `skipView` counts the tabs: each tab's count follows the chips only. */
export function matchesFilters(
  member: Member,
  filters: TeamFilters,
  skipView = false,
): boolean {
  return (
    (skipView || filters.view === "all" || member.status === filters.view) &&
    (filters.role === null || member.role === filters.role) &&
    (filters.mpesa === null || payoutOf(member) === filters.mpesa)
  );
}

export type TeamSortKey = "name" | "role" | "status";

/** The API's own order: by name, or email when there's no name. */
export const DEFAULT_TEAM_SORT: SortState<TeamSortKey> = {
  key: "name",
  dir: "asc",
};

const STATUS_ORDER: Record<MembershipStatus, number> = {
  invited: 0,
  active: 1,
  removed: 2,
};

export function sortMembers(
  members: readonly Member[],
  sort: SortState<TeamSortKey>,
): Member[] {
  const byName = (a: Member, b: Member) =>
    nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase());
  return [...members].sort((a, b) => {
    const primary =
      sort.key === "role"
        ? ROLE_LABELS[a.role].localeCompare(ROLE_LABELS[b.role])
        : sort.key === "status"
          ? STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
          : byName(a, b);
    return (
      (sort.dir === "asc" ? primary : -primary) ||
      byName(a, b) ||
      a.id.localeCompare(b.id)
    );
  });
}

const NAIROBI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayNumber = (moment: Date) =>
  Date.parse(`${NAIROBI_DAY.format(moment)}T00:00:00Z`) / 86_400_000;

/** Whole Nairobi days from `isoDateTime` to `now`. */
export function daysSince(isoDateTime: string, now: Date): number {
  return Math.round(dayNumber(now) - dayNumber(new Date(isoDateTime)));
}

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

export interface TeamStats {
  readonly active: number;
  /** e.g. "2 admins, 6 employees, 1 accountant". */
  readonly breakdown: string;
  readonly invited: number;
  /** e.g. "Oldest sent 16 days ago"; null with no open invites. */
  readonly oldestInvite: string | null;
  /** Active people who can't be paid until they confirm an M-Pesa number. */
  readonly withoutPayout: number;
}

/** Plain counts across the whole team; filters don't change them. */
export function teamStats(members: readonly Member[], now: Date): TeamStats {
  const active = members.filter((member) => member.status === "active");
  const invited = members.filter((member) => member.status === "invited");
  const roleCount = (role: MembershipRole) =>
    active.filter((member) => member.role === role).length;
  const breakdown = (
    [
      ["admin", "admin", "admins"],
      ["employee", "employee", "employees"],
      ["accountant", "accountant", "accountants"],
    ] as const
  )
    .filter(([role]) => roleCount(role) > 0)
    .map(([role, one, many]) => plural(roleCount(role), one, many))
    .join(", ");
  const ages = invited.flatMap((member) =>
    member.invitedAt ? [daysSince(member.invitedAt, now)] : [],
  );
  const oldest = ages.length > 0 ? Math.max(...ages) : null;
  return {
    active: active.length,
    breakdown,
    invited: invited.length,
    oldestInvite:
      invited.length === 0
        ? null
        : oldest === null || oldest <= 0
          ? "Oldest sent today"
          : `Oldest sent ${plural(oldest, "day", "days")} ago`,
    withoutPayout: active.filter((member) => payoutOf(member) === "missing")
      .length,
  };
}

/** The line under "M-Pesa number" in a person's details. */
export function payoutNote(member: Member): string {
  switch (payoutOf(member)) {
    case "none":
      return "Accountants can't be paid through Expendi.";
    case "confirmed":
      return "Confirmed with an SMS code in the app.";
    case "missing":
      return member.status === "invited"
        ? "They add it in the app after they join."
        : "They add it in the app and confirm it with an SMS code.";
  }
}

/** Why an active person can't be paid yet, if they can't. */
export function payoutBlocker(member: Member): string | null {
  if (member.status !== "active" || member.role === "accountant") return null;
  if (!member.payoutPhoneConfirmed) {
    return "Can't be paid until they confirm their M-Pesa number in the app.";
  }
  return member.name === null
    ? "Can't be paid until they add their name in the app."
    : null;
}

/** Where an invite's email points, for the role chosen in the form. */
export function inviteNote(role: MembershipRole): string {
  return role === "accountant"
    ? "They get an email with a link to this dashboard and join when they first sign in."
    : "They get an email with the app's install link and join when they first sign in.";
}
