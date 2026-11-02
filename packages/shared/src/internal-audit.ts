import { z } from "zod";

import type { AuditActorType } from "./audit.js";
import { auditActorTypeSchema } from "./audit.js";

export const AUDIT_SEARCH_PAGE_SIZE = 50;
export const AUDIT_SEARCH_MAX_PAGE_SIZE = 200;

/** A blank query parameter means "no filter". */
const filterText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).max(200).optional(),
);

const nairobiDate = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.iso.date("Use a date like 2026-11-02.").optional(),
);

/**
 * `GET /internal/audit` (spec §6.13, §6.15). Every filter is optional.
 * `action` matches exactly; `actionPrefix` matches the start, e.g.
 * `payout.`. `from` and `to` are Africa/Nairobi calendar days, both
 * inclusive. `cursor` is the previous page's `nextCursor`.
 */
export const auditSearchQuerySchema = z
  .object({
    organizationId: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.uuid("The company ID isn't valid.").optional(),
    ),
    actorType: z.preprocess(
      (value) => (value === "" ? undefined : value),
      auditActorTypeSchema.optional(),
    ),
    actorId: filterText,
    action: filterText,
    actionPrefix: filterText,
    entityType: filterText,
    entityId: filterText,
    from: nairobiDate,
    to: nairobiDate,
    cursor: filterText,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUDIT_SEARCH_MAX_PAGE_SIZE)
      .default(AUDIT_SEARCH_PAGE_SIZE),
  })
  .refine((query) => !(query.action && query.actionPrefix), {
    message: "Search by an exact action or an action prefix, not both.",
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "The start date is after the end date.",
  });

/** What the admin app sends: the query string, before parsing. */
export interface AuditSearchQuery {
  organizationId?: string;
  actorType?: AuditActorType;
  actorId?: string;
  action?: string;
  actionPrefix?: string;
  entityType?: string;
  entityId?: string;
  /** YYYY-MM-DD, Africa/Nairobi. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** What the API searches with, once parsed. */
export type AuditSearchFilters = z.output<typeof auditSearchQuerySchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  actor: z.object({
    type: auditActorTypeSchema,
    /** users.id, staff_users.id, or the component name for system actors. */
    id: z.string(),
    /** The staff member's or user's email; null for system actors. */
    email: z.string().nullable(),
  }),
  /** Null for platform-wide entries. */
  organization: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  action: z.string(),
  entity: z.object({ type: z.string(), id: z.string().nullable() }),
  /** As stored. */
  before: z.json().nullable(),
  after: z.json().nullable(),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** Newest first; `nextCursor` is null on the last page. */
export const auditSearchResponseSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextCursor: z.string().nullable(),
});

export type AuditSearchResponse = z.infer<typeof auditSearchResponseSchema>;
