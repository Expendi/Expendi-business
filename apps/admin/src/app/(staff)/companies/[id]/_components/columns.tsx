import type { CompanyDetail } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { plainColumn } from "~/components/plain-column";

export type CompanyMember = CompanyDetail["members"][number];

export const memberColumns: DataTableColumnDef<CompanyMember>[] = [
  plainColumn<CompanyMember>({
    id: "name",
    title: "Name",
    value: (member) => member.name ?? "—",
    meta: { kind: "main", className: "min-w-40 max-w-64 whitespace-normal" },
  }),
  plainColumn<CompanyMember>({
    id: "email",
    title: "Email",
    value: (member) => member.email,
    cell: (member) => (
      <span className="block max-w-56 truncate" title={member.email}>
        {member.email}
      </span>
    ),
    meta: { className: "min-w-48 max-w-72 whitespace-normal" },
  }),
  plainColumn<CompanyMember>({
    id: "role",
    title: "Role",
    value: (member) => member.role,
  }),
  plainColumn<CompanyMember>({
    id: "status",
    title: "Status",
    value: (member) => member.status,
  }),
];
