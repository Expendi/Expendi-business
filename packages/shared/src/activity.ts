import { z } from "zod";

import { auditActorTypeSchema } from "./audit.js";

export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_MAX_PAGE_SIZE = 200;

/** A blank query parameter means "no filter". */
const blankIsUnset = (value: unknown): unknown =>
  value === "" ? undefined : value;

const nairobiDate = z.preprocess(
  blankIsUnset,
  z.iso.date("Use a date like 2026-11-02.").optional(),
);

/**
 * `GET /organizations/:id/activity` (spec §6.13, §6.14): the company's own
 * audit log, for its admins and accountants. `actionPrefix` matches the
 * start of the action, e.g. `payout.`. `from` and `to` are Africa/Nairobi
 * calendar days, both inclusive. `cursor` is the previous page's
 * `nextCursor`.
 */
export const activityQuerySchema = z
  .object({
    actionPrefix: z.preprocess(
      blankIsUnset,
      z.string().trim().min(1).max(100).optional(),
    ),
    from: nairobiDate,
    to: nairobiDate,
    cursor: z.preprocess(
      blankIsUnset,
      z.string().trim().min(1).max(200).optional(),
    ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_MAX_PAGE_SIZE)
      .default(ACTIVITY_PAGE_SIZE),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "The start date is after the end date.",
  });

/** What the dashboard sends: the query string, before parsing. */
export type ActivityQuery = z.input<typeof activityQuerySchema>;

/** What the API reads the log with, once parsed. */
export type ActivityFilters = z.output<typeof activityQuerySchema>;

export const activityEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  actor: z.object({
    /** A person in the company, Expendi staff, or Expendi's own systems. */
    type: auditActorTypeSchema,
    /** The person's name, or their email until they give one; null for staff and systems. */
    name: z.string().nullable(),
  }),
  /** `<entity>.<past-tense verb>`, e.g. `category.archived`. */
  action: z.string(),
  entity: z.object({ type: z.string(), id: z.string().nullable() }),
  /** The values before and after, as recorded. */
  before: z.json().nullable(),
  after: z.json().nullable(),
});

export type ActivityEntry = z.infer<typeof activityEntrySchema>;

/** Newest first; `nextCursor` is null on the last page. */
export const activityPageSchema = z.object({
  entries: z.array(activityEntrySchema),
  nextCursor: z.string().nullable(),
});

export type ActivityPage = z.infer<typeof activityPageSchema>;
