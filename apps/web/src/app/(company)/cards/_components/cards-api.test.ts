import { describe, expect, it, vi } from "vitest";

import type { CardActionRequest } from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import type { PasskeyAssertion } from "~/lib/passkeys";
import { approveWithPasskey } from "~/lib/approval";
import { cardActionSteps, purchasesQuery } from "./cards-api";

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
        { cardId: null, status: null, needsReceipt: null },
        null,
      ),
      all: purchasesQuery(
        { cardId: "c1", status: "settled", needsReceipt: "true" },
        "next",
      ),
    }).toEqual({
      bare: "limit=30",
      all: "limit=30&cardId=c1&status=settled&needsReceipt=true&cursor=next",
    });
  });
});
