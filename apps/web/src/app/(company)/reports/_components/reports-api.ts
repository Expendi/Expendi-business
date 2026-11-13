"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

import type {
  ExportFile,
  ExportSummary,
  GeneratedExport,
  ReportFormat,
  ReportMonthSummary,
  ReportSpending,
} from "@expendi-business/shared";
import {
  exportFileUrlSchema,
  exportListSchema,
  generatedExportSchema,
  reportFilename,
  reportMonthSummarySchema,
  reportSpendingSchema,
} from "@expendi-business/shared";

import type { ApiClientOptions } from "~/lib/api";
import { readPublicEnv } from "~/env";
import { ApiError } from "~/lib/api";
import { useApi } from "~/lib/use-api";

/**
 * The report routes (T22, T51): any month's files built on the spot for
 * admins and accountants, and, for admins, a stored export with 30-day
 * links to share (spec §6.11, §6.14).
 */

export type SpendingRange = 6 | 12;

export const reportKeys = {
  all: (organizationId: string) => ["reports", organizationId] as const,
  spending: (organizationId: string, month: string, months: SpendingRange) =>
    ["reports", organizationId, "spending", month, months] as const,
  summary: (organizationId: string, month: string) =>
    ["reports", organizationId, "summary", month] as const,
  exports: (organizationId: string) =>
    ["reports", organizationId, "exports"] as const,
};

const reportsPath = (organizationId: string) =>
  `/organizations/${organizationId}/reports` as const;

/** Money out by month up to `month`, with the month before them first. */
export function useReportSpending(
  organizationId: string,
  month: string,
  months: SpendingRange,
): UseQueryResult<ReportSpending> {
  const api = useApi();
  return useQuery({
    queryKey: reportKeys.spending(organizationId, month, months),
    queryFn: () =>
      api.get(
        `${reportsPath(organizationId)}/spending?month=${month}&months=${String(months)}`,
        reportSpendingSchema,
      ),
    placeholderData: keepPreviousData,
  });
}

/** What each of `month`'s files holds, with their first rows. */
export function useReportSummary(
  organizationId: string,
  month: string,
): UseQueryResult<ReportMonthSummary> {
  const api = useApi();
  return useQuery({
    queryKey: reportKeys.summary(organizationId, month),
    queryFn: () =>
      api.get(
        `${reportsPath(organizationId)}/${month}/summary`,
        reportMonthSummarySchema,
      ),
    placeholderData: keepPreviousData,
  });
}

/** Exports made with links: the monthly emails and any an admin shared. */
export function useSharedExports(
  organizationId: string,
): UseQueryResult<ExportSummary[]> {
  const api = useApi();
  return useQuery({
    queryKey: reportKeys.exports(organizationId),
    queryFn: () =>
      api.get(`${reportsPath(organizationId)}/exports`, exportListSchema),
  });
}

export interface ExportFileRequest {
  readonly exported: ExportSummary;
  readonly file: ExportFile;
}

/**
 * Downloads one of a shared export's stored files through a short-lived
 * link; resolves to the file's name.
 */
export function useExportFileDownload(
  organizationId: string,
): UseMutationResult<string, Error, ExportFileRequest> {
  const api = useApi();
  return useMutation({
    mutationFn: async ({ exported, file }) => {
      const { url } = await api.get(
        `${reportsPath(organizationId)}/exports/${exported.id}/files/${file}`,
        exportFileUrlSchema,
      );
      const filename = reportFilename(exported.month, file);
      openDownload(url, filename);
      return filename;
    },
  });
}

/** A receipts zip for a busy month takes a while to build. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

const errorBodySchema = z.object({
  error: z.object({ _tag: z.string(), message: z.string() }),
});

export interface ReportFile {
  readonly filename: string;
  readonly blob: Blob;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The API's refusal as the JSON client would raise it. */
async function refusal(response: Response): Promise<ApiError> {
  const parsed = errorBodySchema.safeParse(parseJson(await response.text()));
  return parsed.success
    ? new ApiError(
        response.status,
        parsed.data.error._tag,
        parsed.data.error.message,
      )
    : new ApiError(
        response.status,
        "HttpError",
        `The API returned an unexpected error (${String(response.status)}).`,
      );
}

interface AuthorisedFile {
  readonly blob: Blob;
  readonly contentDisposition: string | null;
}

/**
 * `GET <path>` as a file. The JSON client can't carry a download, so this
 * sends the same bearer token itself.
 */
async function fetchAuthorisedFile(
  { baseUrl, getAccessToken }: ApiClientOptions,
  path: string,
): Promise<AuthorisedFile> {
  const token = await getAccessToken();
  if (!token) {
    throw new ApiError(
      401,
      "Unauthorized",
      "Your session ended. Sign in again.",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw await refusal(response);
    return {
      blob: await response.blob(),
      contentDisposition: response.headers.get("Content-Disposition"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** `GET …/reports/:month/:format` as a file. */
export async function fetchReportFile(
  options: ApiClientOptions,
  organizationId: string,
  month: string,
  format: ReportFormat,
): Promise<ReportFile> {
  const { blob } = await fetchAuthorisedFile(
    options,
    `/organizations/${organizationId}/reports/${month}/${format}`,
  );
  return { filename: reportFilename(month, format), blob };
}

const RECEIPT_FALLBACK_FILENAME = "payment-receipt.pdf";

/** The name the API gave the download: `attachment; filename="…"`. */
function attachmentFilename(contentDisposition: string | null): string {
  const match = /filename="([^"]+)"/.exec(contentDisposition ?? "");
  return match?.[1] ?? RECEIPT_FALLBACK_FILENAME;
}

/** `GET …/bills/:billId/payment-receipt`: the PDF of a bill paid through Expendi. */
export async function fetchBillPaymentReceipt(
  options: ApiClientOptions,
  organizationId: string,
  billId: string,
): Promise<ReportFile> {
  const { blob, contentDisposition } = await fetchAuthorisedFile(
    options,
    `/organizations/${organizationId}/bills/${billId}/payment-receipt`,
  );
  return { filename: attachmentFilename(contentDisposition), blob };
}

function openDownload(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** Hands a downloaded file to the browser to save. */
function saveFile({ filename, blob }: ReportFile): void {
  const url = URL.createObjectURL(blob);
  openDownload(url, filename);
  // Revoking at once can cancel the save in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface ReportRequest {
  readonly month: string;
  readonly format: ReportFormat;
}

/** Downloads one of a month's files and saves it; resolves to its name. */
export function useReportDownload(
  organizationId: string,
): UseMutationResult<string, Error, ReportRequest> {
  const { getAccessToken } = usePrivy();
  return useMutation({
    mutationFn: async ({ month, format }) => {
      const env = readPublicEnv();
      if (!env.ok) throw new Error("Dashboard API configuration is missing");
      const file = await fetchReportFile(
        { baseUrl: env.env.NEXT_PUBLIC_API_URL, getAccessToken },
        organizationId,
        month,
        format,
      );
      saveFile(file);
      return file.filename;
    },
  });
}

/** Downloads a paid bill's payment receipt and saves it; resolves to its name. */
export function useBillReceiptDownload(
  organizationId: string,
): UseMutationResult<string, Error, string> {
  const { getAccessToken } = usePrivy();
  return useMutation({
    mutationFn: async (billId) => {
      const env = readPublicEnv();
      if (!env.ok) throw new Error("Dashboard API configuration is missing");
      const file = await fetchBillPaymentReceipt(
        { baseUrl: env.env.NEXT_PUBLIC_API_URL, getAccessToken },
        organizationId,
        billId,
      );
      saveFile(file);
      return file.filename;
    },
  });
}

/** Generates `month`'s export with links that work for 30 days. Admins only. */
export function useGenerateExport(
  organizationId: string,
): UseMutationResult<GeneratedExport, Error, string> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (month) =>
      api.post(
        `/organizations/${organizationId}/reports/exports`,
        { month },
        generatedExportSchema,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: reportKeys.exports(organizationId),
      }),
  });
}
