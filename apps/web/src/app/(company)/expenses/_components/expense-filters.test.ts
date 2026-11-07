import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "~/lib/api";
import { createCustomerApi } from "~/lib/customer-api";
import {
  filtersFromParams,
  filtersToParams,
  formatMonth,
  hasChipFilters,
  monthChoices,
  toApiQuery,
} from "./expense-filters";

const PERSON = "00000000-0000-4000-8000-000000000001";
const CATEGORY = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-0000000000aa";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeApi(data: unknown) {
  const fetcher = vi.fn(() =>
    Promise.resolve(Response.json({ success: true, data })),
  );
  vi.stubGlobal("fetch", fetcher);
  const api = createCustomerApi(
    createApiClient({
      baseUrl: "https://api.example.com",
      getAccessToken: () => Promise.resolve("token"),
    }),
  );
  return { api, fetcher };
}

describe("expense filters in the URL", () => {
  it("reads every filter and writes it back the same", () => {
    // #given
    const params = new URLSearchParams({
      membershipId: PERSON,
      kind: "petty_cash",
      categoryId: CATEGORY,
      month: "2026-10",
      etimsStatus: "none",
      status: "submitted",
      noReceipt: "1",
    });

    // #when
    const filters = filtersFromParams(params);

    // #then
    expect({
      filters,
      written: filtersToParams(filters).toString(),
    }).toEqual({
      filters: {
        membershipId: PERSON,
        kind: "petty_cash",
        categoryId: CATEGORY,
        month: "2026-10",
        etimsStatus: "none",
        status: "submitted",
        noReceipt: true,
      },
      written: params.toString(),
    });
  });

  it("drops a filter that isn't valid instead of sending it", () => {
    // #given
    const params = new URLSearchParams({
      membershipId: "someone",
      kind: "salary",
      month: "2026-13",
      status: "lost",
      noReceipt: "maybe",
      etimsStatus: "attached",
    });

    // #when
    const written = filtersToParams(filtersFromParams(params)).toString();

    // #then
    expect(written).toBe("etimsStatus=attached");
  });

  it("takes noReceipt as 1 or 0, or true or false", () => {
    // #when
    const read = ["1", "0", "true", "false"].map(
      (value) =>
        filtersFromParams(new URLSearchParams({ noReceipt: value })).noReceipt,
    );

    // #then
    expect(read).toEqual([true, false, true, false]);
  });

  it("counts the chips set, not the kind tab", () => {
    expect([
      hasChipFilters({ kind: "company" }),
      hasChipFilters({ kind: "company", noReceipt: false }),
    ]).toEqual([false, true]);
  });
});

describe("expense filters for the API", () => {
  it("asks for exactly the filters set, the sort and the next page", async () => {
    // #given
    const { api, fetcher } = fakeApi({ expenses: [], nextCursor: null });
    const query = toApiQuery(
      filtersFromParams(
        new URLSearchParams({
          kind: "claim",
          month: "2026-10",
          noReceipt: "1",
        }),
      ),
    );

    // #when
    await api.listExpenses(ORG, {
      ...query,
      sort: "amount",
      dir: "desc",
      limit: 50,
      cursor: "next-page",
    });

    // #then
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.example.com/organizations/${ORG}/expenses?kind=claim&month=2026-10&noReceipt=true&sort=amount&dir=desc&limit=50&cursor=next-page`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("asks the summary for the same filters, without paging", async () => {
    // #given
    const { api, fetcher } = fakeApi({
      count: 0,
      totalKes: "0",
      waitingForApproval: { count: 0, totalKes: "0" },
      withoutReceipt: { count: 0, totalKes: "0" },
      withoutEtims: { count: 0, totalKes: "0" },
      kinds: { claim: 0, petty_cash: 0, company: 0 },
    });

    // #when
    await api.getExpensesSummary(
      ORG,
      toApiQuery({ status: "payout_failed", noReceipt: false }),
    );

    // #then
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.example.com/organizations/${ORG}/expenses/summary?status=payout_failed&noReceipt=false`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("the month filter", () => {
  it("offers the last twelve months, newest first, and an older chosen one", () => {
    // #when
    const months = monthChoices("2026-11", "2025-06");

    // #then
    expect({
      first: months.slice(0, 3),
      last: months.slice(-2),
      count: months.length,
      label: formatMonth("2026-11"),
    }).toEqual({
      first: ["2026-11", "2026-10", "2026-09"],
      last: ["2025-12", "2025-06"],
      count: 13,
      label: "November 2026",
    });
  });
});
