import type { RequestIdVariables } from "hono/request-id";
import { Cause, Effect, Exit, Option } from "effect";
import { Hono } from "hono";

import type { ExportFile, ReportFormat } from "@expendi-business/shared";
import {
  createExportRequestSchema,
  exportFileSchema,
  reportFilename,
  reportFormatSchema,
  reportMonthSchema,
} from "@expendi-business/shared";

import type { DbScope } from "../db/scope.js";
import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, isClientError } from "../errors.js";
import { readBody } from "../http/body.js";
import {
  clientErrorResponse,
  failureResponse,
  runEffect,
} from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  exportFileUrl,
  exportStorageFailure,
  generateExport,
  listExports,
  openExportLink,
} from "../services/export/artifacts.js";
import { renderEtimsReport } from "../services/export/etims.js";
import {
  EXPORT_CONTENT_TYPES,
  renderExport,
} from "../services/export/render.js";

type CompanyScope = DbScope & { readonly organizationId: string };

const CONTENT_TYPES: Readonly<Record<ReportFormat, string>> = {
  ...EXPORT_CONTENT_TYPES,
  etims: "text/csv; charset=utf-8",
};

/** A month's export file, read fresh rather than from a generated export. */
function freshExportFile(scope: CompanyScope, month: string, file: ExportFile) {
  return renderExport(scope, month, { receipts: file === "receipts" }).pipe(
    Effect.catchTag("StorageError", (error) =>
      Effect.fail(exportStorageFailure(error)),
    ),
    Effect.map((rendered) => rendered[file]),
  );
}

/**
 * `/organizations/:organizationId/reports` (spec §6.11, §6.14). Exports may
 * include salaries, so only admins and accountants get in, and only admins
 * generate; employees never. `/:month/:format` builds any month's export
 * file or eTIMS report on the spot as a download: a pure read, so
 * accountants, who can't generate a stored export, get every month too.
 */
export function createReportRoutes(runtime: AppRuntime) {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/exports", (c) => runEffect(runtime, c, listExports(c.get("tenant"))))
    .post("/exports", (c) => {
      c.header("Cache-Control", "no-store");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, createExportRequestSchema).pipe(
          Effect.flatMap(({ month }) => generateExport(c.get("tenant"), month)),
        ),
        201,
      );
    })
    .get("/exports/:exportId/files/:file", (c) => {
      const file = exportFileSchema.safeParse(c.req.param("file"));
      if (!file.success) {
        return clientErrorResponse(
          c,
          new BadRequest({ message: "Choose workbook, csv or receipts" }),
        );
      }
      c.header("Cache-Control", "no-store");
      return runEffect(
        runtime,
        c,
        exportFileUrl(c.get("tenant"), c.req.param("exportId"), file.data),
      );
    })
    .get("/:month/:format", async (c) => {
      const month = reportMonthSchema.safeParse(c.req.param("month"));
      const format = reportFormatSchema.safeParse(c.req.param("format"));
      if (!month.success || !format.success) {
        return clientErrorResponse(
          c,
          new BadRequest({
            message: "Choose a valid month and report format",
          }),
        );
      }
      const tenant = c.get("tenant");
      const requested = format.data;
      c.header("Cache-Control", "private, no-store");
      const exit = await runtime.runPromiseExit(
        requested === "etims"
          ? renderEtimsReport(tenant, month.data)
          : freshExportFile(tenant, month.data, requested),
      );
      if (Exit.isFailure(exit)) return failureResponse(c, exit.cause);
      // fflate types its bytes as backed by any buffer; Hono takes ArrayBuffer only.
      return c.body(new Uint8Array(exit.value), 200, {
        "Content-Type": CONTENT_TYPES[requested],
        "Content-Disposition": `attachment; filename="${reportFilename(month.data, requested)}"`,
        "X-Content-Type-Options": "nosniff",
      });
    });
}

/** The link's token is in its URL: nothing may cache it or pass it on. */
const LINK_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * `/downloads/reports/:token/:file`: an export's download link, opened
 * from an email or a shared message with no login (spec §6.11). Each time,
 * the token is checked against its 30 days and the browser is sent on to a
 * fresh R2 link that lasts minutes. Refusals are plain text for a person
 * to read.
 */
export function createReportDownloadRoutes(runtime: AppRuntime) {
  return new Hono<{ Variables: RequestIdVariables }>().get(
    "/:token/:file",
    async (c) => {
      const file = exportFileSchema.safeParse(c.req.param("file"));
      if (!file.success) {
        return c.text("This download link isn't valid.", 404, LINK_HEADERS);
      }
      const exit = await runtime.runPromiseExit(
        openExportLink(c.req.param("token"), file.data),
      );
      if (Exit.isSuccess(exit)) {
        for (const [name, value] of Object.entries(LINK_HEADERS)) {
          c.header(name, value);
        }
        return c.redirect(exit.value.url, 302);
      }
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure) && isClientError(failure.value)) {
        return c.text(
          failure.value.message,
          failure.value.status,
          LINK_HEADERS,
        );
      }
      return failureResponse(c, exit.cause);
    },
  );
}
