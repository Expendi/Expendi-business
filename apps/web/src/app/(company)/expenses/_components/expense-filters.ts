import type { z } from "zod";

import type { EtimsStatus, ExpenseListKind } from "@expendi-business/shared";
import { expenseListQuerySchema } from "@expendi-business/shared";

/** The all-expenses filters (spec §6.14), kept in the page's URL. */
export interface ExpenseFilters {
  membershipId?: string;
  kind?: ExpenseListKind;
  categoryId?: string;
  /** `YYYY-MM`, by purchase date. */
  month?: string;
  etimsStatus?: EtimsStatus;
}

const FILTER_NAMES = [
  "membershipId",
  "kind",
  "categoryId",
  "month",
  "etimsStatus",
] as const;

const filterSchema = expenseListQuerySchema.pick({
  membershipId: true,
  kind: true,
  categoryId: true,
  month: true,
  etimsStatus: true,
});

function valid<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  const parsed = schema.safeParse(
    typeof raw === "string" && raw !== "" ? raw : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}

/** Reads filters from the URL or the form; a value that isn't valid is dropped, not sent. */
function readFilters(get: (name: string) => unknown): ExpenseFilters {
  const { shape } = filterSchema;
  return {
    membershipId: valid(shape.membershipId, get("membershipId")),
    kind: valid(shape.kind, get("kind")),
    categoryId: valid(shape.categoryId, get("categoryId")),
    month: valid(shape.month, get("month")),
    etimsStatus: valid(shape.etimsStatus, get("etimsStatus")),
  };
}

export function filtersFromParams(params: {
  get: (name: string) => string | null;
}): ExpenseFilters {
  return readFilters((name) => params.get(name));
}

export function filtersFromForm(form: FormData): ExpenseFilters {
  return readFilters((name) => form.get(name));
}

export function filtersToParams(filters: ExpenseFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = filters[name];
    if (value) params.set(name, value);
  }
  return params;
}
