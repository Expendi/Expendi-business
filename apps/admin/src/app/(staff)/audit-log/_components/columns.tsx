import type { AuditEntry } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { plainColumn } from "~/components/plain-column";
import { Button } from "~/components/ui/button";
import { formatNairobiTime } from "~/lib/format";

export function actorLabel(entry: AuditEntry): string {
  return entry.actor.email ?? entry.actor.id;
}

export function auditColumns({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}): DataTableColumnDef<AuditEntry>[] {
  return [
    plainColumn<AuditEntry>({
      id: "time",
      title: "Time",
      value: (entry) => entry.occurredAt,
      cell: (entry) => (
        <Button
          type="button"
          onClick={() => onSelect(entry.id)}
          aria-expanded={entry.id === selectedId}
          variant="link"
          className="px-0"
        >
          {formatNairobiTime(entry.occurredAt)}
        </Button>
      ),
    }),
    plainColumn<AuditEntry>({
      id: "company",
      title: "Company",
      value: (entry) => entry.organization?.name ?? "Platform",
      cell: (entry) =>
        entry.organization?.name ?? (
          <span className="text-muted-foreground">Platform</span>
        ),
      meta: { className: "min-w-40 max-w-64 whitespace-normal" },
    }),
    plainColumn<AuditEntry>({
      id: "actor",
      title: "Actor",
      value: (entry) => actorLabel(entry),
      cell: (entry) => (
        <span className="break-all">
          <span className="text-xs text-muted-foreground">
            {entry.actor.type}
          </span>{" "}
          {actorLabel(entry)}
        </span>
      ),
      meta: { className: "min-w-40 max-w-64 whitespace-normal" },
    }),
    plainColumn<AuditEntry>({
      id: "action",
      title: "Action",
      value: (entry) => entry.action,
      cell: (entry) => (
        <span className="font-mono text-xs">{entry.action}</span>
      ),
    }),
    plainColumn<AuditEntry>({
      id: "entity",
      title: "Entity",
      value: (entry) => `${entry.entity.type} ${entry.entity.id ?? ""}`,
      cell: (entry) => (
        <span className="font-mono text-xs break-all">
          {entry.entity.type}
          {entry.entity.id ? ` ${entry.entity.id}` : ""}
        </span>
      ),
      meta: { className: "min-w-40 max-w-72 whitespace-normal" },
    }),
  ];
}
