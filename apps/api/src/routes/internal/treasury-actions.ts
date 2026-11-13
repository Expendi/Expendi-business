import type { Context } from "hono";
import { Effect } from "effect";
import { Hono } from "hono";

import type { StaffTreasuryAction } from "@expendi-business/shared";
import {
  staffConfirmRequestSchema,
  staffTreasuryPrepareRequestSchema,
} from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { readBody } from "../../http/body.js";
import { runEffect } from "../../http/respond.js";
import { requireStaffRole } from "../../middleware/staff-auth.js";
import {
  confirmTreasuryAction,
  prepareTreasuryAction,
} from "../../services/staff/treasury-actions.js";

interface Ids {
  readonly organizationId: string;
  readonly moveId: string;
}

/** Both are in every path above; a missing one is refused as an unknown move. */
const idsOf = (params: Record<string, string>): Ids => ({
  organizationId: params.organizationId ?? "",
  moveId: params.moveId ?? "",
});

/**
 * Mounted at `/internal`, behind staff login. Only an ops admin may approve
 * either action, and each needs the second confirmation (spec §6.15).
 *
 * Staff only approve: confirming records the approval and reopens the
 * move, and the `treasury-moves` job does any sending. Nothing here takes a
 * quote, signs or sends, which `internal-routes.test.ts` checks.
 */
export function createTreasuryActionRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  const opsAdmin = requireStaffRole("ops_admin");
  const prepare =
    (action: StaffTreasuryAction) =>
    (c: Context<{ Variables: StaffVariables }>, ids: Ids) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, staffTreasuryPrepareRequestSchema).pipe(
          Effect.flatMap(({ reason }) =>
            prepareTreasuryAction(c.get("staff"), { action, ...ids, reason }),
          ),
        ),
        201,
      );
  const confirm =
    (action: StaffTreasuryAction) =>
    (c: Context<{ Variables: StaffVariables }>, ids: Ids) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, staffConfirmRequestSchema).pipe(
          Effect.flatMap(({ token }) =>
            confirmTreasuryAction(c.get("staff"), { action, ...ids, token }),
          ),
        ),
      );
  const strandedPrepare = prepare("return_stranded_deposit");
  const strandedConfirm = confirm("return_stranded_deposit");
  const resumePrepare = prepare("resume_return");
  const resumeConfirm = confirm("resume_return");
  return new Hono<{ Variables: StaffVariables }>()
    .post(
      "/companies/:organizationId/treasury/moves/:moveId/return-stranded-deposit/prepare",
      opsAdmin,
      (c) => strandedPrepare(c, idsOf(c.req.param())),
    )
    .post(
      "/companies/:organizationId/treasury/moves/:moveId/return-stranded-deposit/confirm",
      opsAdmin,
      (c) => strandedConfirm(c, idsOf(c.req.param())),
    )
    .post(
      "/companies/:organizationId/treasury/moves/:moveId/resume-return/prepare",
      opsAdmin,
      (c) => resumePrepare(c, idsOf(c.req.param())),
    )
    .post(
      "/companies/:organizationId/treasury/moves/:moveId/resume-return/confirm",
      opsAdmin,
      (c) => resumeConfirm(c, idsOf(c.req.param())),
    );
}
