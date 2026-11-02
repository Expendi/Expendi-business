import { Effect } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  companyImportCommitSchema,
  companyImportRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest } from "../errors.js";
import { readBody } from "../http/body.js";
import { readQuery } from "../http/query.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  companyImportDetail,
  listCompanyImports,
} from "../services/import/history.js";
import { companySpreadsheetImport } from "../services/import/imports.js";

export function createCompanyImportRoutes(runtime: AppRuntime) {
  const app = new Hono<{ Variables: TenantVariables }>().use(
    requireRole("admin"),
  );
  app.get("/", (c) =>
    runEffect(
      runtime,
      c,
      readQuery(
        c.req.query(),
        z.object({
          offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        }),
      ).pipe(
        Effect.flatMap(({ offset }) =>
          listCompanyImports(c.get("tenant"), offset),
        ),
      ),
    ),
  );
  app.get("/:id", (c) =>
    runEffect(
      runtime,
      c,
      Effect.gen(function* () {
        const id = c.req.param("id");
        if (!z.uuid().safeParse(id).success)
          return yield* Effect.fail(
            new BadRequest({ message: "Invalid import ID." }),
          );
        return yield* companyImportDetail(c.get("tenant"), id);
      }),
    ),
  );
  for (const mode of ["preview", "commit"] as const) {
    app.post(`/${mode}`, bodyLimit({ maxSize: 1_100_000 }), (c) =>
      runEffect(
        runtime,
        c,
        Effect.gen(function* () {
          if (mode === "preview") {
            const input = yield* readBody(
              c.req.raw,
              companyImportRequestSchema,
            );
            const result = yield* companySpreadsheetImport(
              c.get("tenant"),
              input,
            );
            if (result.type === "preview") return result.report;
          } else {
            const input = yield* readBody(c.req.raw, companyImportCommitSchema);
            const result = yield* companySpreadsheetImport(
              c.get("tenant"),
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
