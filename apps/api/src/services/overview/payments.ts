import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { OverviewPayment } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { query } from "../../db/scope.js";

/**
 * Money out, one row per payment (spec §5, §6.24), dated by the Nairobi day
 * it left. Each kind is counted exactly once (Phase 2B Handoff notes):
 *
 * - Through Expendi: paid claim and bill payouts, at the KES the payout
 *   recorded, so a USD bill keeps its payment-day value. Each part of a
 *   split salary is its own payout; failed attempts never count.
 * - Float issues and top-ups are money handed out, not spent: the float's
 *   spending counts instead, with claims over a float (`float_id`) as
 *   petty cash. Withdrawals move the company's own money.
 * - Recorded spending: company spending, float spending, Card expenses, and
 *   claims imported as paid before Expendi. A bill marked paid outside
 *   appears only as the company spending it recorded (`expenses.bill_id`),
 *   never as a bill as well. A Card expense reads as company spending here
 *   (this response's `kind` doesn't name cards yet).
 *
 * `personId` is who was paid or spent it: the claimant, the float holder,
 * the cardholder, or a bill's payee (their membership, or the personnel
 * payee). Company spending names nobody: its membership is only who recorded
 * it.
 */
export interface SpendingPaymentsFilter {
  /** First day included, `YYYY-MM-DD`. */
  readonly from: string;
  /** First day not included, `YYYY-MM-DD`. */
  readonly until: string;
  readonly personId?: string | undefined;
  /** Leave out petty cash spent from a float, e.g. for payments to a person. */
  readonly withoutFloatSpending?: boolean;
  readonly limit?: number | undefined;
}

export function readSpendingPayments(
  tx: Transaction,
  organizationId: string,
  filter: SpendingPaymentsFilter,
): Effect.Effect<OverviewPayment[], DatabaseError> {
  const { from, until } = filter;
  return query(() =>
    tx.execute<OverviewPayment>(sql`
      SELECT * FROM (
        SELECT p.id::text AS id,
          p.subject_id::text AS "subjectId",
          p.subject_type::text AS kind,
          coalesce(e.merchant, pe.name) AS name,
          (p.paid_at AT TIME ZONE 'Africa/Nairobi')::date::text AS date,
          p.amount_kes::text AS "amountKes",
          CASE WHEN e.float_id IS NOT NULL THEN 'petty_cash'
            ELSE coalesce(e.overview_heading, b.overview_heading)::text END AS heading,
          c.id::text AS "categoryId",
          c.name AS "categoryName",
          coalesce(e.membership_id, pe.membership_id, pe.id)::text AS "personId",
          'expendi' AS channel
        FROM payouts p
        LEFT JOIN expenses e ON p.subject_type = 'claim'
          AND e.id = p.subject_id AND e.organization_id = p.organization_id
        LEFT JOIN bills b ON p.subject_type = 'bill'
          AND b.id = p.subject_id AND b.organization_id = p.organization_id
        LEFT JOIN payees pe ON pe.id = b.payee_id
        JOIN categories c ON c.id = coalesce(e.category_id, b.category_id)
        WHERE p.organization_id = ${organizationId}
          AND p.status = 'paid'
          AND p.subject_type IN ('claim', 'bill')
          AND (p.paid_at AT TIME ZONE 'Africa/Nairobi')::date >= ${from}::date
          AND (p.paid_at AT TIME ZONE 'Africa/Nairobi')::date < ${until}::date
        UNION ALL
        SELECT e.id::text,
          coalesce(e.bill_id, e.id)::text,
          CASE WHEN e.bill_id IS NOT NULL THEN 'bill'
            WHEN e.kind = 'card' THEN 'company'
            ELSE e.kind::text END,
          e.merchant,
          e.spent_on::text,
          e.amount_kes::text,
          CASE WHEN e.float_id IS NOT NULL THEN 'petty_cash'
            ELSE e.overview_heading::text END,
          c.id::text,
          c.name,
          CASE WHEN e.bill_id IS NOT NULL THEN coalesce(pe.membership_id, pe.id)
            WHEN e.kind = 'company' THEN NULL
            ELSE e.membership_id END::text,
          CASE WHEN e.kind = 'float' THEN 'float'
            WHEN e.kind = 'card' THEN 'expendi'
            ELSE 'outside' END
        FROM expenses e
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN bills b ON b.id = e.bill_id
        LEFT JOIN payees pe ON pe.id = b.payee_id
        WHERE e.organization_id = ${organizationId}
          AND (
            (e.kind IN ('company', 'card') AND e.status = 'recorded')
            OR (e.kind = 'float' AND e.status = 'recorded' AND NOT ${filter.withoutFloatSpending ?? false})
            OR (e.kind = 'claim' AND e.status = 'paid_outside')
          )
          AND e.spent_on >= ${from}::date
          AND e.spent_on < ${until}::date
      ) payments
      WHERE ${filter.personId ?? null}::text IS NULL OR "personId" = ${filter.personId ?? null}::text
      ORDER BY date DESC, id DESC
      LIMIT ${filter.limit ?? null}
    `),
  ).pipe(Effect.map(({ rows }) => rows));
}
