import { createHash, randomBytes, randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { Config, Effect } from "effect";

import type {
  ExportFile,
  ExportFileUrl,
  ExportSummary,
  GeneratedExport,
} from "@expendi-business/shared";
import { EXPORT_FILES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { ReportExportRow } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { PresignedUrl, StorageError } from "../storage/file-storage.js";
import type { RenderedExport } from "./render.js";
import {
  reportExportLinks,
  reportExports,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Forbidden,
  Gone,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { FileStorage } from "../storage/file-storage.js";
import { nairobiMonth } from "./month.js";
import {
  EXPORT_CONTENT_TYPES,
  exportFilename,
  renderExport,
} from "./render.js";

/**
 * Generated exports and their download links (spec §6.11). The files live
 * privately in R2. A link is the API's own URL with a random token: R2's
 * signed URLs last at most 7 days, so opening the link checks the token and
 * its 30 days here, then redirects to a fresh R2 link that lasts minutes.
 */

export const EXPORT_LINK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const newExportToken = (): string =>
  randomBytes(32).toString("base64url");

/** Salted with its purpose, so a token minted for anything else never opens an export. */
export const hashExportToken = (token: string): string =>
  createHash("sha256")
    .update(`expendi-report-export:${token}`, "utf8")
    .digest("hex");

export const exportStorageKey = (
  row: Pick<ReportExportRow, "organizationId" | "id" | "month">,
  file: ExportFile,
): string =>
  `org/${row.organizationId}/exports/${row.id}/${exportFilename(row.month, file)}`;

const storageNotSetUp = new ServiceUnavailable({
  message: "Exports aren't set up yet. Please try again later.",
});

const storageDown = new ServiceUnavailable({
  message: "Couldn't reach the export files. Try again in a moment.",
});

/** Storage problems as the person asking should read them. */
export const exportStorageFailure = (
  error: StorageError,
): ServiceUnavailable =>
  error.code === "NOT_CONFIGURED" ? storageNotSetUp : storageDown;

const failStorage = (error: StorageError) =>
  Effect.fail(exportStorageFailure(error));

const linksNotSetUp = new ServiceUnavailable({
  message: "Export links aren't set up yet. Please try again later.",
});

/** The API's public address (`API_PUBLIC_URL`), which download links point at. */
export const apiPublicUrl: Effect.Effect<URL, ServiceUnavailable> = Effect.gen(
  function* () {
    return yield* Config.url("API_PUBLIC_URL");
  },
).pipe(Effect.mapError(() => linksNotSetUp));

export function exportLinks(
  baseUrl: URL,
  token: string,
): Record<ExportFile, string> {
  const link = (file: ExportFile) =>
    new URL(`/downloads/reports/${token}/${file}`, baseUrl).href;
  return {
    workbook: link("workbook"),
    csv: link("csv"),
    receipts: link("receipts"),
  };
}

/** Files first: a row, and so a link, only ever exists once its files do. */
export function uploadExport(
  row: Pick<ReportExportRow, "organizationId" | "id" | "month">,
  rendered: RenderedExport,
): Effect.Effect<void, StorageError, FileStorage> {
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    yield* Effect.forEach(
      EXPORT_FILES,
      (file) =>
        storage.put({
          key: exportStorageKey(row, file),
          bytes: rendered[file],
          contentType: EXPORT_CONTENT_TYPES[file],
        }),
      { discard: true },
    );
  });
}

export function toExportSummary(
  row: ReportExportRow,
  createdBy: string | null,
): ExportSummary {
  return {
    id: row.id,
    month: row.month,
    monthly: row.monthly,
    createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

const creatorName = sql<
  string | null
>`coalesce(nullif(btrim(${users.fullName}), ''), ${users.email})`;

const adminsOnly = new Forbidden({
  message: "Only admins can generate an export",
});

const futureMonth = new BadRequest({
  message:
    "That month hasn't started yet. Choose this month or an earlier one.",
});

/**
 * An admin generates `month`'s export and gets its links, to open or share
 * (spec §6.11). Any month, again and again: each export is a fresh read
 * with its own link.
 */
export function generateExport(
  tenant: Tenant,
  month: string,
  now: Date = new Date(),
): Effect.Effect<
  GeneratedExport,
  Forbidden | BadRequest | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage | AuditLog
> {
  return Effect.gen(function* () {
    if (tenant.role !== "admin") return yield* Effect.fail(adminsOnly);
    if (month > nairobiMonth(now)) return yield* Effect.fail(futureMonth);
    const baseUrl = yield* apiPublicUrl;
    const rendered = yield* renderExport(tenant, month);
    const draft = {
      id: randomUUID(),
      organizationId: tenant.organizationId,
      month,
    };
    yield* uploadExport(draft, rendered);

    const token = newExportToken();
    const saved = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const [row] = yield* query(() =>
          tx
            .insert(reportExports)
            .values({
              ...draft,
              expiresAt: new Date(now.getTime() + EXPORT_LINK_LIFETIME_MS),
              createdAt: now,
              createdBy: tenant.userId,
            })
            .returning(),
        );
        if (!row)
          return yield* Effect.dieMessage("export insert returned no row");
        const [link] = yield* query(() =>
          tx
            .insert(reportExportLinks)
            .values({
              organizationId: row.organizationId,
              exportId: row.id,
              tokenHash: hashExportToken(token),
            })
            .returning({ id: reportExportLinks.id }),
        );
        const [creator] = yield* query(() =>
          tx
            .select({ name: creatorName })
            .from(users)
            .where(eq(users.id, tenant.userId)),
        );
        yield* audit.record(tx, {
          actor: { type: "user", id: tenant.userId },
          organizationId: row.organizationId,
          action: "report_export.generated",
          entity: { type: "report_export", id: row.id },
          after: {
            month,
            monthly: false,
            linkId: link?.id ?? null,
            expiresAt: row.expiresAt,
          },
        });
        return toExportSummary(row, creator?.name ?? null);
      }),
    );
    return { ...saved, links: exportLinks(baseUrl, token) };
  }).pipe(Effect.catchTag("StorageError", failStorage));
}

/** The company's latest exports, newest first, for admins and accountants. */
export function listExports(
  tenant: Tenant,
): Effect.Effect<ExportSummary[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select({ row: reportExports, createdBy: creatorName })
        .from(reportExports)
        .leftJoin(users, eq(users.id, reportExports.createdBy))
        .where(eq(reportExports.organizationId, tenant.organizationId))
        .orderBy(desc(reportExports.createdAt), desc(reportExports.id))
        .limit(36),
    ),
  ).pipe(
    Effect.map((rows) =>
      rows.map(({ row, createdBy }) =>
        toExportSummary(row, row.createdBy === null ? null : createdBy),
      ),
    ),
  );
}

const exportNotFound = new NotFound({ message: "Export not found" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A short-lived link to one of an export's files, for a signed-in admin or accountant. */
export function exportFileUrl(
  tenant: Tenant,
  exportId: string,
  file: ExportFile,
): Effect.Effect<
  ExportFileUrl,
  NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    if (!UUID.test(exportId)) return yield* Effect.fail(exportNotFound);
    const [row] = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select()
          .from(reportExports)
          .where(eq(reportExports.id, exportId))
          .limit(1),
      ),
    );
    if (row?.organizationId !== tenant.organizationId) {
      return yield* Effect.fail(exportNotFound);
    }
    const storage = yield* FileStorage;
    const signed = yield* storage.presignDownload(exportStorageKey(row, file));
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }).pipe(Effect.catchTag("StorageError", failStorage));
}

interface LinkTarget extends Record<string, unknown> {
  readonly export_id: string;
  readonly organization_id: string;
  readonly month: string;
  readonly expires_at: Date | string;
}

const linkInvalid = new NotFound({
  message: "This download link isn't valid.",
});

const linkExpired = new Gone({
  message:
    "This download link has expired. Ask the company's admin to share a new export.",
});

/**
 * Opens an emailed or shared link: the token must be one Expendi issued,
 * for an export whose 30 days aren't up, and, for an accountant's link,
 * an accountant who hasn't been removed. Unknown, mistyped and revoked
 * links all get the same answer.
 */
export function openExportLink(
  token: string,
  file: ExportFile,
  now: Date = new Date(),
): Effect.Effect<
  PresignedUrl,
  NotFound | Gone | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    if (!TOKEN_PATTERN.test(token)) return yield* Effect.fail(linkInvalid);
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<LinkTarget>(
          sql`SELECT export_id, organization_id, month, expires_at FROM report_export_by_token(${hashExportToken(token)})`,
        ),
      ),
    );
    const [target] = rows;
    if (!target) return yield* Effect.fail(linkInvalid);
    if (now.getTime() >= new Date(target.expires_at).getTime()) {
      return yield* Effect.fail(linkExpired);
    }
    const storage = yield* FileStorage;
    return yield* storage.presignDownload(
      exportStorageKey(
        {
          id: target.export_id,
          organizationId: target.organization_id,
          month: target.month,
        },
        file,
      ),
    );
  }).pipe(Effect.catchTag("StorageError", failStorage));
}
