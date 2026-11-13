import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { billKeys, recurringKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { refreshAfterRecurringChange } from "./recurring-api";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";

describe("after a recurring payment changes", () => {
  it("refreshes the cards whose recurring payments it changes, with the bills and recurring payments", async () => {
    // #given
    const keys = [
      recurringKeys.list(ORG),
      billKeys.list(ORG, "open"),
      queryKeys.cardList(ORG),
      queryKeys.companyHeldCards(ORG),
      queryKeys.cardLoads(ORG),
    ];
    const client = new QueryClient();
    for (const queryKey of keys) client.setQueryData(queryKey, {});

    // #when
    await refreshAfterRecurringChange(client, ORG);

    // #then
    expect(
      keys.map((queryKey) => client.getQueryState(queryKey)?.isInvalidated),
    ).toEqual([true, true, true, true, false]);
  });
});
