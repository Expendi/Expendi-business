"use client";

import type { FormEvent, JSX } from "react";
import { useState } from "react";

import type {
  AssignableRole,
  InviteMemberResponse,
  Member,
  MembershipRole,
} from "@expendi-business/shared";
import {
  ASSIGNABLE_ROLES,
  inviteMemberRequestSchema,
  MEMBER_NAME_MAX_LENGTH,
  MEMBERSHIP_ROLES,
  WEB_DASHBOARD_URL,
} from "@expendi-business/shared";

import {
  alertClass,
  cellClass,
  headCellClass,
  inputClass,
  primaryButton,
  secondaryButton,
  tableClass,
  textButton,
} from "~/components/styles";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import {
  useChangeMemberRole,
  useInviteMember,
  useMembers,
  useRemoveMember,
} from "./team-api";

/** What each role can do (spec §4), as the app words it. */
const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  admin: "Approves and pays claims, and manages the wallet and team.",
  employee: "Submits their own claims in the app and gets paid to M-Pesa.",
  accountant:
    "View-only access to this dashboard, plus monthly exports by email.",
};

/**
 * The company's people (spec §6.2, §6.14): admins invite, change roles and
 * remove, accountants included; accountants see the list.
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

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-stone-600">
          {canAct
            ? "Invite admins, employees and accountants. Removing someone ends their access; their unpaid claims can still be paid."
            : "Everyone in the company and their role. Only admins change the team."}
        </p>
      </div>

      {canAct ? <InviteForm organizationId={organizationId} /> : null}

      {members.isPending ? (
        <p className="text-sm text-stone-500">Loading the team…</p>
      ) : members.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(members.error)}</p>
          <button
            type="button"
            onClick={() => void members.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className={tableClass}>
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                <th scope="col" className={headCellClass}>
                  Person
                </th>
                <th scope="col" className={headCellClass}>
                  Role
                </th>
                <th scope="col" className={headCellClass}>
                  Status
                </th>
                <th scope="col" className={headCellClass}>
                  M-Pesa number
                </th>
                {canAct ? (
                  <th scope="col" className={headCellClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {members.data.map((member) => (
                <MemberRow
                  key={member.id}
                  organizationId={organizationId}
                  member={member}
                  canAct={canAct}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function InviteForm({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const invite = useInviteMember(organizationId);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<MembershipRole>("employee");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const parsed = inviteMemberRequestSchema.safeParse({
      email: values.get("email"),
      fullName: values.get("fullName"),
      role,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the details.");
      return;
    }
    setError(null);
    invite.mutate(parsed.data, {
      onSuccess: () => {
        form.reset();
        setRole("employee");
      },
    });
  }

  return (
    <section aria-labelledby="invite-heading" className="space-y-3">
      <h2 id="invite-heading" className="text-base font-semibold">
        Invite someone
      </h2>
      <form
        onSubmit={onSubmit}
        aria-label="Invite someone"
        className="grid max-w-4xl gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-3"
      >
        <label className="text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="off"
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          Full name
          <input
            name="fullName"
            maxLength={MEMBER_NAME_MAX_LENGTH}
            autoComplete="off"
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          Role
          <select
            name="role"
            value={role}
            onChange={(event) => {
              const next = MEMBERSHIP_ROLES.find(
                (candidate) => candidate === event.target.value,
              );
              if (next) setRole(next);
            }}
            className={inputClass}
          >
            {MEMBERSHIP_ROLES.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-stone-600">
            {ROLE_DESCRIPTIONS[role]}
          </span>
        </label>
        {error ? (
          <p className={`${alertClass} sm:col-span-3`} role="alert">
            {error}
          </p>
        ) : null}
        {invite.isError ? (
          <p className={`${alertClass} sm:col-span-3`} role="alert">
            {describeApiError(invite.error)}
          </p>
        ) : null}
        <div className="sm:col-span-3">
          <button
            type="submit"
            disabled={invite.isPending}
            className={primaryButton}
          >
            {invite.isPending ? "Inviting…" : "Send invite"}
          </button>
        </div>
      </form>
      {invite.data ? <InviteSent result={invite.data} /> : null}
    </section>
  );
}

/** Where an invite points: the app for staff, this dashboard for accountants. */
function inviteLink(result: InviteMemberResponse): string | null {
  return result.member.role === "accountant"
    ? WEB_DASHBOARD_URL
    : result.installUrl;
}

function InviteSent({ result }: { result: InviteMemberResponse }): JSX.Element {
  const link = inviteLink(result);
  const who = result.member.name ?? result.member.email;
  return (
    <div
      role="status"
      className={`max-w-4xl rounded-lg border p-4 text-sm ${result.emailSent ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}
    >
      {result.emailSent ? (
        <p>
          Invite sent to {who} at {result.member.email}.
        </p>
      ) : (
        <>
          <p>
            {who} is invited, but the email didn&apos;t go out.
            {link ? " Send them this link yourself:" : ""}
          </p>
          {link ? <p className="mt-1 font-mono break-all">{link}</p> : null}
        </>
      )}
    </div>
  );
}

function MemberRow({
  organizationId,
  member,
  canAct,
}: {
  organizationId: string;
  member: Member;
  canAct: boolean;
}): JSX.Element {
  return (
    <tr className="border-t border-stone-200 align-top">
      <td className={cellClass}>
        <span className="font-medium">{member.name ?? "No name yet"}</span>
        <span className="block text-xs text-stone-500">{member.email}</span>
      </td>
      <td className={cellClass}>
        {canAct && member.role !== "accountant" ? (
          <RoleChanger organizationId={organizationId} member={member} />
        ) : (
          ROLE_LABELS[member.role]
        )}
      </td>
      <td className={cellClass}>
        {member.status === "invited" ? (
          <>
            Invited
            {member.invitedAt ? (
              <span className="block text-xs text-stone-500">
                {formatNairobiDateTime(member.invitedAt)}
              </span>
            ) : null}
          </>
        ) : (
          "Active"
        )}
      </td>
      <td className={cellClass}>
        {member.role === "accountant"
          ? "—"
          : member.payoutPhoneConfirmed
            ? "Confirmed"
            : "Not yet"}
      </td>
      {canAct ? (
        <td className={`${cellClass} text-right`}>
          <MemberActions organizationId={organizationId} member={member} />
        </td>
      ) : null}
    </tr>
  );
}

function RoleChanger({
  organizationId,
  member,
}: {
  organizationId: string;
  member: Member;
}): JSX.Element {
  const change = useChangeMemberRole(organizationId);
  const current = ASSIGNABLE_ROLES.find((role) => role === member.role);
  const [role, setRole] = useState<AssignableRole | undefined>(current);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Role for ${member.name ?? member.email}`}
          value={role}
          onChange={(event) =>
            setRole(
              ASSIGNABLE_ROLES.find(
                (candidate) => candidate === event.target.value,
              ),
            )
          }
          disabled={change.isPending}
          className={`${inputClass} mt-0 w-auto`}
        >
          {ASSIGNABLE_ROLES.map((option) => (
            <option key={option} value={option}>
              {ROLE_LABELS[option]}
            </option>
          ))}
        </select>
        {role && role !== current ? (
          <button
            type="button"
            disabled={change.isPending}
            onClick={() => change.mutate({ membershipId: member.id, role })}
            className={secondaryButton}
          >
            {change.isPending ? "Saving…" : "Change role"}
          </button>
        ) : null}
      </div>
      {change.isError ? (
        <p className="text-sm text-error-700" role="alert">
          {describeApiError(change.error)}
        </p>
      ) : null}
    </div>
  );
}

function MemberActions({
  organizationId,
  member,
}: {
  organizationId: string;
  member: Member;
}): JSX.Element {
  const remove = useRemoveMember(organizationId);
  const resend = useInviteMember(organizationId);
  const [confirming, setConfirming] = useState(false);
  const who = member.name ?? member.email;

  return (
    <div className="flex flex-col items-end gap-2">
      {member.status === "invited" && member.name ? (
        <button
          type="button"
          disabled={resend.isPending}
          onClick={() =>
            resend.mutate({
              email: member.email,
              fullName: member.name ?? "",
              role: member.role,
            })
          }
          className={textButton}
        >
          {resend.isPending ? "Sending…" : "Resend invite"}
        </button>
      ) : null}
      {resend.data ? (
        <p className="text-sm text-stone-600" role="status">
          {resend.data.emailSent
            ? "Invite sent again."
            : "The email didn't go out. Try again later."}
        </p>
      ) : null}
      {resend.isError ? (
        <p className="text-sm text-error-700" role="alert">
          {describeApiError(resend.error)}
        </p>
      ) : null}

      {confirming ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-sm text-stone-700">
            {member.status === "invited"
              ? `Cancel ${who}'s invite?`
              : `Remove ${who}?`}
          </span>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate(member.id)}
            className={primaryButton}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              remove.reset();
              setConfirming(false);
            }}
            className={secondaryButton}
          >
            Keep
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={textButton}
        >
          Remove
        </button>
      )}
      {remove.isError ? (
        <p className="text-sm text-error-700" role="alert">
          {describeApiError(remove.error)}
        </p>
      ) : null}
    </div>
  );
}
