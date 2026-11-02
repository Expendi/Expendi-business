import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";

import type { GeneratedExport } from "@expendi-business/shared";
import { generatedExportSchema } from "@expendi-business/shared";

import { useApi } from "~/providers/api-provider";

/** Generates a month's export and its 30-day links (spec §6.11). Admins only. */
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
