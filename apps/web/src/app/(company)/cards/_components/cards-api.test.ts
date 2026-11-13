import type { QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { CardActionRequest, CardPurchase } from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import type { PasskeyAssertion } from "~/lib/passkeys";
import { PURCHASES_NEEDING_ANSWER } from "~/app/dev/preview/_harness/fixtures/cards";
import { billKeys, recurringKeys } from "~/features/payment-keys";
import { approveWithPasskey } from "~/lib/approval";
import { queryKeys } from "~/lib/query-keys";
import {
  afterPurchaseAnswered,
  afterPurchaseReceipt,
  attachCardReceipt,
  cardActionSteps,
  cardRevealSteps,
  purchasesQuery,
  refreshAfterCardChange,
  reviewCardPurchase,
} from "./cards-api";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const CHALLENGE = "00000000-0000-4000-8000-000000000b01";
const CONFIRM = `/organizations/${ORG}/cards/confirmations`;

const assertion = { id: "credential" } as unknown as PasskeyAssertion;

function fakeApi() {
  const post = vi.fn((path: string, _body: unknown, _schema: unknown) =>
    Promise.resolve(
      path === CONFIRM
        ? { challengeId: CHALLENGE, options: { challenge: "abc" } }
        : { type: "load_balance" },
    ),
  );
  const api: ApiClient = {
    get: () => Promise.reject(new Error("no reads")),
    post: post as ApiClient["post"],
    put: () => Promise.reject(new Error("no puts")),
    patch: () => Promise.reject(new Error("no patches")),
    delete: () => Promise.reject(new Error("no deletes")),
  };
  return { api, post };
}

describe("a passkey-confirmed card action", () => {
  const action: CardActionRequest = {
    type: "load_balance",
    amountUsd: "250.50",
  };

  it("sends the same action to both steps", async () => {
    // #given
    const { api, post } = fakeApi();

    // #when
    const outcome = await approveWithPasskey(
      cardActionSteps(api, ORG),
      action,
      () => Promise.resolve(assertion),
    );

    // #then
    expect(outcome.status).toBe("approved");
    expect(post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [CONFIRM, action],
      [`${CONFIRM}/${CHALLENGE}`, { action, response: assertion }],
    ]);
  });

  it("sends nothing to confirm when the passkey prompt is cancelled", async () => {
    // #given
    const { api, post } = fakeApi();

    // #when
    const outcome = await approveWithPasskey(
      cardActionSteps(api, ORG),
      action,
      () => Promise.resolve(null),
    );

    // #then
    expect({
      status: outcome.status,
      calls: post.mock.calls.length,
    }).toEqual({ status: "cancelled", calls: 1 });
  });
});

describe("purchasesQuery", () => {
  it("leaves out filters that aren't set and carries the cursor", () => {
    expect({
      bare: purchasesQuery(
        { cardId: null, status: null, needsReceipt: null, needsReview: null },
        null,
      ),
      all: purchasesQuery(
        {
          cardId: "c1",
          status: "settled",
          needsReceipt: "true",
          needsReview: "true",
        },
        "next",
      ),
    }).toEqual({
      bare: "limit=30",
      all: "limit=30&cardId=c1&status=settled&needsReceipt=true&needsReview=true&cursor=next",
    });
  });
});

describe("a company-held card's passkey steps", () => {
  it("issues one with no cardholder, sending the same action to both steps", async () => {
    // #given
    const { api, post } = fakeApi();
    const action: CardActionRequest = {
      type: "issue_company_card",
      nickname: "Vercel",
      monthlyLimitUsd: "25.00",
      defaultCategoryId: "00000000-0000-4000-8000-000000000c01",
    };

    // #when
    await approveWithPasskey(cardActionSteps(api, ORG), action, () =>
      Promise.resolve(assertion),
    );

    // #then
    expect(post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [CONFIRM, action],
      [`${CONFIRM}/${CHALLENGE}`, { action, response: assertion }],
    ]);
  });

  it("reveals its number with a fresh passkey and hands the page's address over", async () => {
    // #given
    const cardId = "00000000-0000-4000-8000-000000000d01";
    const reveal = {
      type: "reveal_card",
      revealUrl: "https://business.test/card-reveal#session",
      expiresAt: "2026-11-13T10:05:00.000Z",
    };
    const post = vi.fn((path: string, _body: unknown, _schema: unknown) =>
      Promise.resolve(
        path === CONFIRM
          ? { challengeId: CHALLENGE, options: { challenge: "abc" } }
          : reveal,
      ),
    );
    const api = { ...fakeApi().api, post: post as ApiClient["post"] };
    const onSession = vi.fn();

    // #when
    const outcome = await approveWithPasskey(
      cardRevealSteps(api, ORG, onSession),
      cardId,
      () => Promise.resolve(assertion),
    );

    // #then
    expect({
      status: outcome.status,
      sent: post.mock.calls.map(([, body]) => body),
      session: onSession.mock.calls,
    }).toEqual({
      status: "approved",
      sent: [
        { type: "reveal_card", cardId },
        {
          action: { type: "reveal_card", cardId },
          response: assertion,
        },
      ],
      session: [[{ url: reveal.revealUrl, expiresAt: reveal.expiresAt }]],
    });
  });
});

describe("answering for a new merchant's purchase", () => {
  const purchaseId = "00000000-0000-4000-8000-000000000e01";
  const recurringItemId = "00000000-0000-4000-8000-000000000e02";

  it.each([
    [{ decision: "link", recurringItemId }],
    [{ decision: "one_off" }],
    [{ decision: "not_recognised" }],
  ] as const)("posts %o to the purchase's review", async (review) => {
    // #given
    const { api, post } = fakeApi();

    // #when
    await reviewCardPurchase(api, ORG, purchaseId, review);

    // #then
    expect(post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [`/organizations/${ORG}/cards/purchases/${purchaseId}/review`, review],
    ]);
  });
});

const NEEDS_ANSWER_LIST = queryKeys.cardPurchases(ORG, {
  cardId: null,
  status: null,
  needsReceipt: null,
  needsReview: "true",
});

/** A client holding each query, so a test can see which ones were invalidated. */
function clientWith(keys: readonly QueryKey[]): QueryClient {
  const client = new QueryClient();
  for (const queryKey of keys) client.setQueryData(queryKey, {});
  return client;
}

const invalidated = (client: QueryClient, keys: readonly QueryKey[]) =>
  keys.map((queryKey) => client.getQueryState(queryKey)?.isInvalidated);

describe("after a purchase is answered", () => {
  const [waiting] = PURCHASES_NEEDING_ANSWER;
  if (!waiting) throw new Error("The samples have a purchase to answer.");
  const answered: CardPurchase = {
    ...waiting,
    match: {
      state: "not_recognised",
      recurringItemId: null,
      billId: null,
      payeeName: null,
    },
  };

  it("keeps the saved purchase for its open sheet, then refreshes the lists, bills and recurring payments", async () => {
    // #given
    const lists = [
      NEEDS_ANSWER_LIST,
      queryKeys.cardList(ORG),
      queryKeys.expenses(ORG),
      billKeys.list(ORG, "open"),
      recurringKeys.list(ORG),
    ];
    const client = clientWith(lists);

    // #when
    await afterPurchaseAnswered(client, ORG, answered);

    // #then
    expect({
      kept: client.getQueryData(queryKeys.cardPurchase(ORG, answered.id)),
      refreshed: invalidated(client, lists),
    }).toEqual({
      kept: answered,
      refreshed: [true, true, true, true, true],
    });
  });

  it("keeps a purchase given its receipt, refreshing the cards and expenses but not bills", async () => {
    // #given
    const withReceipt: CardPurchase = {
      ...answered,
      receiptCount: 1,
      needsReceipt: false,
    };
    const lists = [
      NEEDS_ANSWER_LIST,
      queryKeys.expenses(ORG),
      billKeys.list(ORG, "open"),
    ];
    const client = clientWith(lists);

    // #when
    await afterPurchaseReceipt(client, ORG, withReceipt);

    // #then
    expect({
      kept: client.getQueryData(queryKeys.cardPurchase(ORG, withReceipt.id)),
      refreshed: invalidated(client, lists),
    }).toEqual({ kept: withReceipt, refreshed: [true, true, false] });
  });

  it("posts a company-held card purchase's receipts to the purchase", async () => {
    // #given
    const { api, post } = fakeApi();
    const receiptFileId = "00000000-0000-4000-8000-000000000f01";

    // #when
    await attachCardReceipt(api, ORG, {
      purchaseId: answered.id,
      receiptFileIds: [receiptFileId],
    });

    // #then
    expect(post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [
        `/organizations/${ORG}/cards/purchases/${answered.id}/receipts`,
        { receiptFileIds: [receiptFileId] },
      ],
    ]);
  });
});

describe("after a card changes", () => {
  it("refreshes the cards, and the bills and recurring payments it pays", async () => {
    // #given
    const keys = [
      queryKeys.cardList(ORG),
      queryKeys.companyHeldCards(ORG),
      billKeys.list(ORG, "open"),
      billKeys.detail(ORG, "00000000-0000-4000-8000-000000000b02"),
      recurringKeys.list(ORG),
      queryKeys.expenses(ORG),
    ];
    const client = clientWith(keys);

    // #when
    await refreshAfterCardChange(client, ORG);

    // #then
    expect(invalidated(client, keys)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
