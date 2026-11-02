import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "~/lib/api";
import { createCustomerApi } from "~/lib/customer-api";
import {
  filtersFromForm,
  filtersFromParams,
  filtersToParams,
} from "./expense-filters";

const PERSON = "00000000-0000-4000-8000-000000000001";
const CATEGORY = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-0000000000aa";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("expense filters in the URL", () => {
  it("reads every filter and writes it back the same", () => {
    // #given
    const params = new URLSearchParams({
      membershipId: PERSON,
      kind: "petty_cash",
      categoryId: CATEGORY,
      month: "2026-10",
      etimsStatus: "none",
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
      etimsStatus: "attached",
    });

    // #when
    const written = filtersToParams(filtersFromParams(params)).toString();

    // #then
    expect(written).toBe("etimsStatus=attached");
  });

  it("leaves out the form's blank choices", () => {
    // #given
    const form = new FormData();
    form.set("membershipId", "");
    form.set("kind", "company");
    form.set("month", "");

    // #when
    const written = filtersToParams(filtersFromForm(form)).toString();

    // #then
    expect(written).toBe("kind=company");
  });

  it("asks the API for exactly the filters set, and the next page", async () => {
    // #given
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json({
          success: true,
          data: { expenses: [], nextCursor: null },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const api = createCustomerApi(
      createApiClient({
        baseUrl: "https://api.example.com",
        getAccessToken: () => Promise.resolve("token"),
      }),
    );

    // #when
    await api.listExpenses(ORG, {
      ...filtersFromParams(
        new URLSearchParams({ kind: "claim", month: "2026-10" }),
      ),
      limit: 50,
      cursor: "next-page",
    });

    // #then
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.example.com/organizations/${ORG}/expenses?kind=claim&month=2026-10&limit=50&cursor=next-page`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});
