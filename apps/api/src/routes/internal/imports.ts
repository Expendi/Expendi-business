import { Effect } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  importCommitSchema,
  importRequestSchema,
} from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { BadRequest } from "../../errors.js";
import { readBody } from "../../http/body.js";
import { runEffect } from "../../http/respond.js";
import { requireStaffRole } from "../../middleware/staff-auth.js";
import { spreadsheetImport } from "../../services/import/imports.js";

export function createImportRoutes(runtime: AppRuntime) {
  const app = new Hono<{ Variables: StaffVariables }>();
  for (const mode of ["preview", "commit"] as const) {
    app.post(
      `/companies/:organizationId/imports/${mode}`,
      requireStaffRole("ops_admin"),
      bodyLimit({ maxSize: 1_100_000 }),
      (c) =>
        runEffect(
          runtime,
          c,
          Effect.gen(function* () {
            const organizationId = c.req.param("organizationId");
            if (!z.uuid().safeParse(organizationId).success)
              return yield* Effect.fail(
                new BadRequest({ message: "Invalid company ID." }),
              );
            if (mode === "preview") {
              const input = yield* readBody(c.req.raw, importRequestSchema);
              const result = yield* spreadsheetImport(
                c.get("staff"),
                organizationId,
                input,
              );
              if (result.type === "preview") return result.report;
            } else {
              const input = yield* readBody(c.req.raw, importCommitSchema);
              const result = yield* spreadsheetImport(
                c.get("staff"),
                organizationId,
                input,
                input.previewToken,
              );
              if (result.type === "committed") return result.result;
            }
            return yield* Effect.fail(
              new BadRequest({ message: "Invalid import mode." }),
            );
          }),
        ),
    );
  }
  return app;
}
