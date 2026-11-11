import type { JSX } from "react";
import { cn } from "cn";
import {
  CircleCheckIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react";

import type { Member } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { EntityMark, Mini, RowMeta, RowTitle } from "~/components/data/cells";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { ROLE_LABELS } from "~/config/roles";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { MemberStatusBadge } from "./member-sheet";
import { nameOf, PAYOUT_LABELS, payoutOf } from "./team-display";

export function YouMini(): JSX.Element {
  return (
    <Mini icon={UserRoundIcon} label="You">
      You
    </Mini>
  );
}

export function PayoutMini({ member }: { member: Member }): JSX.Element {
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

function PayoutCell({ member }: { member: Member }): JSX.Element {
  const state = payoutOf(member);
  const warn = state === "missing" && member.status === "active";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        state === "confirmed"
          ? "text-secondary-foreground"
          : warn
            ? "text-warn-700"
            : "text-muted-foreground",
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

export function teamColumns({
  myId,
  onOpen,
}: {
  myId: string | null;
  onOpen: (id: string) => void;
}): DataTableColumnDef<Member>[] {
  return [
    {
      id: "name",
      accessorFn: (member) => nameOf(member),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Person" />
      ),
      cell: ({ row }) => {
        const member = row.original;
        return (
          <span className="flex min-w-0 items-start gap-3">
            <EntityMark name={nameOf(member)} kind="person" />
            <span className="min-w-0">
              <RowTitle onOpen={() => onOpen(member.id)}>
                {member.name ?? (
                  <span className="text-muted-foreground">No name yet</span>
                )}
              </RowTitle>
              <RowMeta text={member.email}>
                {member.id === myId ? <YouMini /> : null}
              </RowMeta>
            </span>
          </span>
        );
      },
      meta: { kind: "main", label: "Person" },
    },
    {
      id: "role",
      accessorFn: (member) => ROLE_LABELS[member.role],
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Role" />
      ),
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {ROLE_LABELS[row.original.role]}
        </span>
      ),
      meta: { label: "Role" },
    },
    {
      id: "mpesa",
      accessorFn: (member) => payoutOf(member),
      enableSorting: false,
      header: () => <span>M-Pesa number</span>,
      cell: ({ row }) => <PayoutCell member={row.original} />,
      meta: { label: "M-Pesa number" },
    },
    {
      id: "status",
      accessorFn: (member) => member.status,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => {
        const member = row.original;
        return (
          <>
            <MemberStatusBadge member={member} />
            {member.status === "invited" && member.invitedAt ? (
              <span className="mt-1 block text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
                Sent {formatNairobiDateTime(member.invitedAt)}
              </span>
            ) : null}
          </>
        );
      },
      meta: { label: "Status" },
    },
  ];
}
