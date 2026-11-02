"use client";

import type { UseMutationResult } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import type { GeneratedExport, ReportFormat } from "@expendi-business/shared";
import {
  generatedExportSchema,
  reportFilename,
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

/**
 * `GET …/reports/:month/:format` as a file. The JSON client can't carry a
 * download, so this sends the same bearer token itself.
 */
export async function fetchReportFile(
  { baseUrl, getAccessToken }: ApiClientOptions,
  organizationId: string,
  month: string,
  format: ReportFormat,
): Promise<ReportFile> {
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
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/organizations/${organizationId}/reports/${month}/${format}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw await refusal(response);
    return {
      filename: reportFilename(month, format),
      blob: await response.blob(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Hands a downloaded file to the browser to save. */
function saveFile({ filename, blob }: ReportFile): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
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

/** Generates `month`'s export with links that work for 30 days. Admins only. */
export function useGenerateExport(
  organizationId: string,
): UseMutationResult<GeneratedExport, Error, string> {
  const api = useApi();
  return useMutation({
    mutationFn: (month) =>
      api.post(
        `/organizations/${organizationId}/reports/exports`,
        { month },
        generatedExportSchema,
      ),
  });
}
