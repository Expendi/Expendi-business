import type { InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { CardPurchase, CardPurchaseList } from "@expendi-business/shared";

import type { ApiClient } from "../../lib/api";
import { ApiError } from "../../lib/api";
import {
  attachCardReceipt,
  attachReceiptRequest,
  confirmCardReveal,
  findLoadedPurchase,
  findMyCardPurchase,
  freezeCard,
  listMyCardPurchases,
  listMyCards,
  requestCardReveal,
} from "./card-api";

const ORG = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const PURCHASE = "33333333-3333-4333-8333-333333333333";
const OTHER_PURCHASE = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";
const CATEGORY = "66666666-6666-4666-8666-666666666666";
const CHALLENGE = "77777777-7777-4777-8777-777777777777";
const FILE = "88888888-8888-4888-8888-888888888888";

interface Call {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

function fakeApi(...responses: unknown[]): {
  api: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const next = () => {
    if (responses.length === 0) throw new Error("no response left");
    return responses.shift();
  };
  const api: ApiClient = {
    get: (path, schema) => {
      calls.push({ method: "GET", path });
      return Promise.resolve(schema.parse(next()));
    },
    post: (path, body, schema) => {
      calls.push({ method: "POST", path, body });
      return Promise.resolve(schema.parse(next()));
    },
    patch: () => Promise.reject(new Error("unused")),
    delete: () => Promise.reject(new Error("unused")),
  };
  return { api, calls };
}

const holder = {
  membershipId: MEMBERSHIP,
  name: "Jane",
  email: "j@example.com",
};

function card() {
  return {
    id: CARD,
    nickname: "Marketing subscriptions",
    lastFour: "1234",
    state: "open",
    monthlyLimitUsdCents: "50000",
    spentThisMonthUsdCents: "12050",
    holder,
    yours: true,
    defaultCategory: { id: CATEGORY, name: "Software" },
    issuedAt: "2026-11-01T08:00:00.000Z",
    closedAt: null,
  };
}

function purchase(id: string): CardPurchase {
  return {
    id,
    kind: "purchase",
    status: "pending",
    card: { id: CARD, nickname: "Marketing subscriptions", lastFour: "1234" },
    holder,
    yours: true,
    merchant: "ACME SOFTWARE",
    mcc: "5734",
    holdUsdCents: "1000",
    settledUsdCents: "0",
    amountKes: null,
    usdKesRate: null,
    authorizedAt: "2026-11-08T10:00:00.000Z",
    declineReason: null,
    expenseId: null,
    category: { id: CATEGORY, name: "Software" },
    receiptCount: 0,
    noReceiptReason: null,
    needsReceipt: true,
    changedAfterExpense: false,
  };
}

function page(
  purchases: CardPurchase[],
  nextCursor: string | null,
): CardPurchaseList {
  return { purchases, nextCursor };
}

const cardsPath = `/organizations/${ORG}/cards`;

describe("the cardholder's lists", () => {
  it("asks only for the caller's own cards", async () => {
    // #given
    const { api, calls } = fakeApi({ cards: [card()] });

    // #when
    const result = await listMyCards(api, ORG);

    // #then
    expect(calls).toEqual([{ method: "GET", path: `${cardsPath}?mine=true` }]);
    expect(result.cards[0]?.lastFour).toBe("1234");
  });

  it("filters purchases by card, and pages with an encoded cursor", async () => {
    // #given
    const { api, calls } = fakeApi(page([], null));

    // #when
    await listMyCardPurchases(api, ORG, { cardId: CARD, cursor: "a/b c" });

    // #then
    expect(calls[0]?.path).toBe(
      `${cardsPath}/purchases?mine=true&cardId=${CARD}&cursor=a%2Fb%20c`,
    );
  });

  it("asks for the purchases still needing a receipt", async () => {
    // #given
    const { api, calls } = fakeApi(page([purchase(PURCHASE)], null));

    // #when
    await listMyCardPurchases(api, ORG, { needsReceipt: true, limit: 5 });

    // #then
    expect(calls[0]?.path).toBe(
      `${cardsPath}/purchases?mine=true&needsReceipt=true&limit=5`,
    );
  });
});

describe("findMyCardPurchase", () => {
  it("reads the purchase by its ID", async () => {
    // #given
    const { api, calls } = fakeApi(purchase(PURCHASE));

    // #when
    const found = await findMyCardPurchase(api, ORG, PURCHASE);

    // #then
    expect(found?.id).toBe(PURCHASE);
    expect(calls[0]?.path).toBe(
      `/organizations/${ORG}/cards/purchases/${PURCHASE}`,
    );
  });

  it("is null when the API says it isn't this person's", async () => {
    // #given
    const { api } = fakeApi();
    api.get = () => Promise.reject(new ApiError(404, "NotFound", "Not found"));

    // #when
    const found = await findMyCardPurchase(api, ORG, PURCHASE);

    // #then
    expect(found).toBeNull();
  });

  it("passes other failures on", async () => {
    // #given
    const { api } = fakeApi();
    const failure = new ApiError(503, "ServiceUnavailable", "Try again");
    api.get = () => Promise.reject(failure);

    // #when / #then
    await expect(findMyCardPurchase(api, ORG, PURCHASE)).rejects.toBe(failure);
  });
});

describe("findLoadedPurchase", () => {
  it("finds a purchase in a list that's already loaded", () => {
    // #given
    const list: InfiniteData<CardPurchaseList, string | null> = {
      pages: [
        page([purchase(OTHER_PURCHASE)], "x"),
        page([purchase(PURCHASE)], null),
      ],
      pageParams: [null, "x"],
    };

    // #when
    const found = findLoadedPurchase([undefined, list], PURCHASE);

    // #then
    expect(found?.id).toBe(PURCHASE);
  });

  it("is undefined when no list has it", () => {
    expect(findLoadedPurchase([undefined], PURCHASE)).toBeUndefined();
  });
});

describe("freezeCard", () => {
  it("posts to the card's freeze route with no body", async () => {
    // #given
    const { api, calls } = fakeApi({ anything: true });

    // #when
    await freezeCard(api, ORG, CARD);

    // #then
    expect(calls).toEqual([
      { method: "POST", path: `${cardsPath}/${CARD}/freeze`, body: undefined },
    ]);
  });
});

describe("revealing a card", () => {
  const options = { challenge: "abc" };
  const assertion = { id: "credential" };

  it("asks for a challenge bound to this card", async () => {
    // #given
    const { api, calls } = fakeApi({ challengeId: CHALLENGE, options });

    // #when
    const challenge = await requestCardReveal(api, ORG, CARD);

    // #then
    expect(challenge.challengeId).toBe(CHALLENGE);
    expect(calls).toEqual([
      {
        method: "POST",
        path: `${cardsPath}/confirmations`,
        body: { type: "reveal_card", cardId: CARD },
      },
    ]);
  });

  it("sends back the same action with the signature", async () => {
    // #given
    const { api, calls } = fakeApi({
      type: "reveal_card",
      revealUrl: "https://business.expendi.app/card-reveal#session=fake",
      expiresAt: "2026-11-08T10:05:00.000Z",
    });

    // #when
    const session = await confirmCardReveal(
      api,
      ORG,
      CARD,
      CHALLENGE,
      assertion,
    );

    // #then
    expect(calls).toEqual([
      {
        method: "POST",
        path: `${cardsPath}/confirmations/${CHALLENGE}`,
        body: {
          action: { type: "reveal_card", cardId: CARD },
          response: assertion,
        },
      },
    ]);
    expect(session).toEqual({
      url: "https://business.expendi.app/card-reveal#session=fake",
      expiresAt: "2026-11-08T10:05:00.000Z",
    });
  });

  it("refuses an answer that isn't a reveal", async () => {
    // #given
    const { api } = fakeApi({ type: "unfreeze_card", card: card() });

    // #when
    const result = confirmCardReveal(api, ORG, CARD, CHALLENGE, assertion);

    // #then
    await expect(result).rejects.toBeInstanceOf(ApiError);
  });
});

describe("adding a receipt", () => {
  it("leaves the category out when the holder didn't change it", () => {
    // #when
    const request = attachReceiptRequest([FILE], CATEGORY, CATEGORY);

    // #then
    expect(request).toEqual({ receiptFileIds: [FILE] });
  });

  it("sends a changed category with the receipt", () => {
    // #when
    const request = attachReceiptRequest([FILE], OTHER_PURCHASE, CATEGORY);

    // #then
    expect(request).toEqual({
      receiptFileIds: [FILE],
      categoryId: OTHER_PURCHASE,
    });
  });

  it("posts to the purchase's receipts route", async () => {
    // #given
    const { api, calls } = fakeApi({ anything: true });
    const request = { receiptFileIds: [FILE] };

    // #when
    await attachCardReceipt(api, ORG, PURCHASE, request);

    // #then
    expect(calls).toEqual([
      {
        method: "POST",
        path: `${cardsPath}/purchases/${PURCHASE}/receipts`,
        body: request,
      },
    ]);
  });
});
