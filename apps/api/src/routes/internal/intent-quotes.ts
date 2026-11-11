import { Effect } from "effect";
import { Hono } from "hono";

import {
  intentQuoteQueueQuerySchema,
  intentQuoteResolvePrepareRequestSchema,
  staffConfirmRequestSchema,
} from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { readBody } from "../../http/body.js";
import { readQuery } from "../../http/query.js";
import { runEffect } from "../../http/respond.js";
import { requireStaffRole } from "../../middleware/staff-auth.js";
import {
  confirmQuoteResolution,
  prepareQuoteResolution,
} from "../../services/staff/intent-quote-resolve.js";
import {
  intentQuoteDetail,
  intentQuoteEvidence,
  intentQuoteQueue,
} from "../../services/staff/intent-quotes.js";

/**
 * Mounted at `/internal`, behind staff login (spec §6.15). Every staff role
 * can look at the NEAR Intents quotes that need a person, including what
 * 1Click and the chains show of one; only an ops admin can resolve one.
 * Nothing here signs or sends: resolving corrects a quote's record and
 * hands its payouts back to the code that follows them.
 */
export function createIntentQuoteRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  const opsAdmin = requireStaffRole("ops_admin");
  return new Hono<{ Variables: StaffVariables }>()
    .get("/intent-quotes", (c) =>
      runEffect(
        runtime,
        c,
        readQuery(c.req.query(), intentQuoteQueueQuerySchema).pipe(
          Effect.flatMap(intentQuoteQueue),
        ),
      ),
    )
    .get("/intent-quotes/:quoteId", (c) =>
      runEffect(runtime, c, intentQuoteDetail(c.req.param("quoteId"))),
    )
    .get("/intent-quotes/:quoteId/evidence", (c) =>
      runEffect(runtime, c, intentQuoteEvidence(c.req.param("quoteId"))),
    )
    .post("/intent-quotes/:quoteId/resolve/prepare", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, intentQuoteResolvePrepareRequestSchema).pipe(
          Effect.flatMap((request) =>
            prepareQuoteResolution(
              c.get("staff"),
              c.req.param("quoteId"),
              request,
            ),
          ),
        ),
        201,
      ),
    )
    .post("/intent-quotes/:quoteId/resolve/confirm", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, staffConfirmRequestSchema).pipe(
          Effect.flatMap(({ token }) =>
            confirmQuoteResolution(
              c.get("staff"),
              c.req.param("quoteId"),
              token,
            ),
          ),
        ),
      ),
    );
}
