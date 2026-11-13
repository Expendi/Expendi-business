"use client";

import type { LucideIcon } from "lucide-react";
import type { FormEvent, JSX, ReactNode } from "react";
import { cn } from "cn";
import {
  CircleCheckIcon,
  CopyIcon,
  MailIcon,
  SendIcon,
  TriangleAlertIcon,
  UserIcon,
  UserXIcon,
} from "lucide-react";
import { useId, useState } from "react";

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
} from "@expendi-business/shared";

import type { SheetStepper } from "~/components/data/detail-sheet";
import { Banner } from "~/components/data/banner";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { ChoiceGroup, ChoiceOption } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import {
  useChangeMemberRole,
  useInviteMember,
  useRemoveMember,
} from "./team-api";
import {
  inviteNote,
  memberStatus,
  nameOf,
  PAYOUT_LABELS,
  payoutBlocker,
  payoutNote,
  payoutOf,
  ROLE_DESCRIPTIONS,
} from "./team-display";

export function MemberStatusBadge({
  member,
  className,
}: {
  member: Member;
  className?: string;
}): JSX.Element {
  const status = memberStatus(member);
  return (
    <StatusBadge tone={status.tone} className={className}>
      {status.label}
    </StatusBadge>
  );
}

/** Keeps "M-Pesa" on one line instead of breaking at its hyphen. */
function keepMpesaWhole(text: string): ReactNode[] {
  return text
    .split(/(M-Pesa)/)
    .filter(Boolean)
    .map((part, index) =>
      part === "M-Pesa" ? (
        <span key={index} className="whitespace-nowrap">
          {part}
        </span>
      ) : (
        part
      ),
    );
}

function Note({
  icon: Icon,
  tone = "neutral",
  children,
}: {
  icon: LucideIcon;
  tone?: "neutral" | "success" | "warn";
  children: ReactNode;
}): JSX.Element {
  return (
    <p className="flex items-start gap-2 text-muted-foreground">
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "success"
            ? "text-success-700"
            : tone === "warn"
              ? "text-warn-600"
              : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A link the admin can copy, shown when an invite email didn't go out. */
function InviteLink({ link }: { link: string }): JSX.Element {
  return (
    <p className="mt-2 rounded-control border border-border bg-muted/60 px-2.5 py-2 [overflow-wrap:anywhere] text-foreground">
      {link}
    </p>
  );
}

export function CopyLinkButton({ link }: { link: string }): JSX.Element {
  const [outcome, setOutcome] = useState<"copied" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setOutcome("copied");
    } catch {
      setOutcome("failed");
    }
  }

  return (
    <>
      <Button variant="outline" size="md" onClick={() => void copy()}>
        <CopyIcon aria-hidden="true" />
        {outcome === "copied" ? "Link copied" : "Copy link"}
      </Button>
      <span role="status" className="sr-only">
        {outcome === "copied" ? "Link copied." : ""}
      </span>
      {outcome === "failed" ? (
        <span role="alert" className="basis-full text-xs text-muted-foreground">
          Couldn&apos;t copy. Select the link and copy it.
        </span>
      ) : null}
    </>
  );
}

/** What happened to an invite: sent, or invited with a link to share. */
export function InviteBanner({
  result,
  onDone,
}: {
  result: InviteMemberResponse;
  onDone: () => void;
}): JSX.Element {
  const who = result.member.name ?? result.member.email;
  const done = (
    <Button variant="outline" size="md" onClick={onDone}>
      Done
    </Button>
  );
  if (result.emailSent) {
    return (
      <Banner
        tone="success"
        role="status"
        aria-label="Invite result"
        title={`Invite sent to ${who} at ${result.member.email}.`}
        actions={done}
      />
    );
  }
  return (
    <Banner
      tone="warn"
      role="status"
      aria-label="Invite result"
      title={`${who} is invited, but the email didn't go out.`}
      actions={
        <>
          {result.inviteLink ? (
            <CopyLinkButton link={result.inviteLink} />
          ) : null}
          {done}
        </>
      }
    >
      {result.inviteLink ? (
        <>
          <p>Send them this link yourself:</p>
          <InviteLink link={result.inviteLink} />
        </>
      ) : (
        <p>Resend the invite later from their details.</p>
      )}
    </Banner>
  );
}

function RoleChoices({
  legend,
  name,
  roles,
  value,
  current,
  onChange,
}: {
  legend: string;
  name: string;
  roles: readonly MembershipRole[];
  value: MembershipRole;
  current?: MembershipRole;
  onChange: (role: MembershipRole) => void;
}): JSX.Element {
  return (
    <ChoiceGroup legend={legend}>
      {roles.map((role) => (
        <ChoiceOption
          key={role}
          name={name}
          value={role}
          checked={value === role}
          title={ROLE_LABELS[role]}
          badge={
            current === role ? (
              <span className="text-xs leading-4 font-normal text-muted-foreground">
                Current
              </span>
            ) : null
          }
          description={keepMpesaWhole(ROLE_DESCRIPTIONS[role])}
          onChoose={() => onChange(role)}
        />
      ))}
    </ChoiceGroup>
  );
}

type Mode =
  | {
      readonly kind: "role";
      readonly id: string;
      readonly role: AssignableRole;
    }
  | { readonly kind: "remove"; readonly id: string };

/**
 * A person's details, and the admin's changes as steps in the same sheet:
 * resending an invite, changing a role, removing them.
 */
export function MemberSheet({
  organizationId,
  member,
  canAct,
  isMe,
  stepper,
  onClose,
}: {
  organizationId: string;
  member: Member | undefined;
  canAct: boolean;
  isMe: boolean;
  stepper: SheetStepper;
  onClose: () => void;
}): JSX.Element {
  const { company } = useDashboard();
  const [mode, setMode] = useState<Mode | null>(null);
  const resend = useInviteMember(organizationId);
  const change = useChangeMemberRole(organizationId);
  const remove = useRemoveMember(organizationId);
  const step = member && mode?.id === member.id ? mode : null;
  const busy = change.isPending || remove.isPending;

  function back() {
    change.reset();
    remove.reset();
    setMode(null);
  }

  function close() {
    back();
    onClose();
  }

  if (!member) {
    return (
      <DetailSheet open={false} onClose={close} title="">
        {null}
      </DetailSheet>
    );
  }

  const who = nameOf(member);

  if (step?.kind === "role") {
    return (
      <DetailSheet
        open
        onClose={close}
        dismissible={!busy}
        eyebrow={who}
        title="Change role"
        stepKey={`${member.id}-role`}
        footer={
          <>
            <Button
              type="submit"
              form="role-form"
              disabled={step.role === member.role || change.isPending}
            >
              {change.isPending ? "Saving…" : "Change role"}
            </Button>
            <Button variant="outline" disabled={busy} onClick={back}>
              Back
            </Button>
          </>
        }
      >
        <form
          id="role-form"
          aria-label="Change role"
          className="flex flex-col gap-[18px]"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            change.mutate(
              { membershipId: member.id, role: step.role },
              { onSuccess: back },
            );
          }}
        >
          <RoleChoices
            legend={`Role for ${who}`}
            name="role"
            roles={ASSIGNABLE_ROLES}
            value={step.role}
            current={member.role}
            onChange={(role) => {
              const next = ASSIGNABLE_ROLES.find((option) => option === role);
              if (next) {
                change.reset();
                setMode({ kind: "role", id: member.id, role: next });
              }
            }}
          />
          {isMe && step.role === "employee" ? (
            <Callout tone="warn">
              <p>
                You&apos;ll lose access to this dashboard. Employees use only
                the app.
              </p>
            </Callout>
          ) : null}
          {change.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(change.error)}</p>
              </Callout>
            </div>
          ) : null}
        </form>
      </DetailSheet>
    );
  }

  if (step?.kind === "remove") {
    const invited = member.status === "invited";
    const lines = invited
      ? ["Their invite stops working. You can invite them again later."]
      : [
          "Removing a person ends their access.",
          ...(member.role === "accountant"
            ? []
            : ["Their unpaid reimbursements can still be paid."]),
        ];
    if (isMe) {
      lines.push(`You'll lose access to ${company.name} straight away.`);
    }
    return (
      <DetailSheet
        open
        onClose={close}
        dismissible={!busy}
        eyebrow={who}
        title={invited ? `Cancel ${who}'s invite?` : `Remove ${who}?`}
        stepKey={`${member.id}-remove`}
        footer={
          <>
            <Button
              disabled={remove.isPending}
              onClick={() => remove.mutate(member.id, { onSuccess: close })}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
            <Button variant="outline" disabled={busy} onClick={back}>
              Keep
            </Button>
          </>
        }
      >
        <Callout tone="warn" icon={UserXIcon}>
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Callout>
        {remove.isError ? (
          <div role="alert">
            <Callout tone="error">
              <p>{describeApiError(remove.error)}</p>
            </Callout>
          </div>
        ) : null}
      </DetailSheet>
    );
  }

  const assignable = ASSIGNABLE_ROLES.find((role) => role === member.role);
  const blocker = payoutBlocker(member);
  const resent = resend.variables?.email === member.email;

  return (
    <DetailSheet
      open
      onClose={close}
      eyebrow={
        isMe ? `${ROLE_LABELS[member.role]} · You` : ROLE_LABELS[member.role]
      }
      title={member.name ?? "No name yet"}
      headerExtra={<MemberStatusBadge member={member} className="mt-2" />}
      stepper={stepper}
      stepKey={member.id}
      footer={
        canAct ? (
          <>
            <SheetActions kind="primary">
              {member.status === "invited" && member.name ? (
                <Button
                  disabled={resend.isPending}
                  onClick={() =>
                    resend.mutate({
                      email: member.email,
                      fullName: member.name ?? "",
                      role: member.role,
                    })
                  }
                >
                  {resend.isPending ? null : <SendIcon aria-hidden="true" />}
                  {resend.isPending ? "Sending…" : "Resend invite"}
                </Button>
              ) : null}
              {assignable ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    setMode({ kind: "role", id: member.id, role: assignable })
                  }
                >
                  <UserIcon aria-hidden="true" />
                  Change role
                </Button>
              ) : null}
            </SheetActions>
            <SheetActions kind="secondary">
              <Button
                variant="danger"
                size="md"
                onClick={() => setMode({ kind: "remove", id: member.id })}
              >
                Remove
              </Button>
            </SheetActions>
            {assignable ? null : (
              <ReadOnlyNote wide>
                An accountant&apos;s role can&apos;t be changed.
              </ReadOnlyNote>
            )}
          </>
        ) : (
          <>
            <ReadOnlyNote>View only. Only admins change the team.</ReadOnlyNote>
            <SheetPosition index={stepper.index} total={stepper.total} />
          </>
        )
      }
    >
      {blocker ? (
        <Callout tone="warn">
          <p>{keepMpesaWhole(blocker)}</p>
        </Callout>
      ) : null}
      <DetailList>
        <DetailItem label="Email">{member.email}</DetailItem>
        <DetailItem
          label="Role"
          sub={keepMpesaWhole(ROLE_DESCRIPTIONS[member.role])}
        >
          {ROLE_LABELS[member.role]}
        </DetailItem>
        {member.status === "invited" && member.invitedAt ? (
          <DetailItem label="Invite sent">
            {formatNairobiDateTime(member.invitedAt)}
          </DetailItem>
        ) : null}
        <DetailItem
          label="M-Pesa number"
          sub={keepMpesaWhole(payoutNote(member))}
        >
          {PAYOUT_LABELS[payoutOf(member)]}
        </DetailItem>
      </DetailList>
      {member.status === "invited" ? (
        <Note icon={MailIcon}>
          They join when they first sign in with this email.
        </Note>
      ) : null}
      {resent && resend.data ? (
        resend.data.emailSent ? (
          <div role="status">
            <Note icon={CircleCheckIcon} tone="success">
              Invite sent again.
            </Note>
          </div>
        ) : (
          <div role="status">
            <Note icon={TriangleAlertIcon} tone="warn">
              The email didn&apos;t go out.{" "}
              {resend.data.inviteLink
                ? "Send them this link yourself, or try again later."
                : "Try again later."}
            </Note>
            {resend.data.inviteLink ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 pl-6">
                <div className="basis-full">
                  <InviteLink link={resend.data.inviteLink} />
                </div>
                <CopyLinkButton link={resend.data.inviteLink} />
              </div>
            ) : null}
          </div>
        )
      ) : null}
      {resent && resend.isError ? (
        <div role="alert">
          <Callout tone="error">
            <p>{describeApiError(resend.error)}</p>
          </Callout>
        </div>
      ) : null}
    </DetailSheet>
  );
}

const ENTER_EMAIL = "Enter the person's email address.";

interface InviteErrors {
  readonly email?: string;
  readonly fullName?: string;
}

/** Inviting (spec §6.2): email, full name and a role. Cash-outs need the name to pay them. */
export function InviteSheet({
  organizationId,
  open,
  onClose,
  onInvited,
}: {
  organizationId: string;
  open: boolean;
  onClose: () => void;
  onInvited: (result: InviteMemberResponse) => void;
}): JSX.Element {
  const invite = useInviteMember(organizationId);
  const [role, setRole] = useState<MembershipRole>("employee");
  const [errors, setErrors] = useState<InviteErrors>({});
  const emailId = useId();
  const nameId = useId();

  function close() {
    invite.reset();
    setErrors({});
    setRole("employee");
    onClose();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const typed = values.get("email");
    const email = typeof typed === "string" ? typed : "";
    const parsed = inviteMemberRequestSchema.safeParse({
      email,
      fullName: values.get("fullName"),
      role,
    });
    if (!parsed.success) {
      const issueFor = (field: "email" | "fullName") =>
        parsed.error.issues.find((issue) => issue.path[0] === field)?.message;
      const next: InviteErrors = {
        email: email.trim() === "" ? ENTER_EMAIL : issueFor("email"),
        fullName: issueFor("fullName"),
      };
      setErrors(next);
      const firstBad = form.elements.namedItem(
        next.email ? "email" : "fullName",
      );
      if (firstBad instanceof HTMLInputElement) firstBad.focus();
      return;
    }
    setErrors({});
    invite.mutate(parsed.data, {
      onSuccess: (result) => {
        invite.reset();
        setRole("employee");
        onInvited(result);
      },
    });
  }

  return (
    <DetailSheet
      open={open}
      onClose={close}
      dismissible={!invite.isPending}
      eyebrow="Team"
      title="Invite someone"
      footer={
        <>
          <Button type="submit" form="invite-form" disabled={invite.isPending}>
            {invite.isPending ? "Inviting…" : "Send invite"}
          </Button>
          <Button variant="outline" disabled={invite.isPending} onClick={close}>
            Cancel
          </Button>
        </>
      }
    >
      <form
        id="invite-form"
        aria-label="Invite someone"
        noValidate
        onSubmit={onSubmit}
        className="flex flex-col gap-[18px]"
      >
        <Field>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>
          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="off"
            placeholder="name@company.co.ke"
            aria-invalid={errors.email ? true : undefined}
            onChange={() => setErrors((now) => ({ ...now, email: undefined }))}
          />
          <FieldError>{errors.email}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={nameId}>Full name</FieldLabel>
          <Input
            id={nameId}
            name="fullName"
            maxLength={MEMBER_NAME_MAX_LENGTH}
            autoComplete="off"
            aria-invalid={errors.fullName ? true : undefined}
            onChange={() =>
              setErrors((now) => ({ ...now, fullName: undefined }))
            }
          />
          <FieldError>{errors.fullName}</FieldError>
        </Field>
        <RoleChoices
          legend="Role"
          name="role"
          roles={MEMBERSHIP_ROLES}
          value={role}
          onChange={setRole}
        />
        <Note icon={MailIcon}>{inviteNote(role)}</Note>
        {invite.isError ? (
          <div role="alert">
            <Callout tone="error">
              <p>{describeApiError(invite.error)}</p>
            </Callout>
          </div>
        ) : null}
      </form>
    </DetailSheet>
  );
}
