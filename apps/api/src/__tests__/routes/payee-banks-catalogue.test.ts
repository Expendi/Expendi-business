import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CreatePayeeResponse, Payee } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { listCashOutBanks } from "../../services/cash-out/banks.js";
import {
  Paycrest,
  PaycrestError,
} from "../../services/paycrest/paycrest-client.js";
import { TEST_ORIGIN } from "../helpers/fakes.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

/**
 * The bank picker and the bank check on save come from Expendi's own
 * catalogue, so they work while Paycrest answers nothing at all.
 */
const calls: string[] = [];
const down = (call: string) =>
  Effect.sync(() => calls.push(call)).pipe(
    Effect.zipRight(
      Effect.fail(
        new PaycrestError({
          message: "Paycrest is down",
          status: 503,
          code: "TRANSPORT_ERROR",
          ambiguous: false,
        }),
      ),
    ),
  );
const PaycrestDown = Layer.succeed(Paycrest, {
  rate: () => down("rate"),
  institutions: () => down("institutions"),
  verifyAccount: () => down("verifyAccount"),
  createOrder: () => down("createOrder"),
  getOrder: () => down("getOrder"),
  verifyWebhookSignature: () => false,
});

let runtime: AppRuntime;
let app: App;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ paycrest: PaycrestDown });
  const { db } = await runtime.runPromise(DatabaseService);
  app = createApp({ runtime });
  paying = await createPayingCompany(runtime, db);
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(() => {
  calls.length = 0;
});

const base = () => `/organizations/${paying.company.organizationId}/payees`;

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...bearer(paying.company.admin.privyUserId),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function dataOf<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T };
  return body.data;
}

const bankPayee = (bankCode: string) => ({
  kind: "supplier",
  name: "Acme Supplies Ltd",
  details: {
    method: "bank",
    bankCode,
    accountNumber: "0123456789",
    accountName: "Acme Supplies Ltd",
  },
});

describe("banks while Paycrest is down", () => {
  it("lists every catalogue bank for the picker", async () => {
    // #when
    const response = await send("GET", `${base()}/banks`);

    // #then
    expect({
      status: response.status,
      banks: await dataOf<unknown>(response),
      calls,
    }).toEqual({ status: 200, banks: listCashOutBanks(), calls: [] });
  });

  it("saves a bank payee, checked against the catalogue", async () => {
    // #when
    const requested = await send("POST", base(), bankPayee("PRIEKENX"));
    const result = await dataOf<CreatePayeeResponse>(requested);
    if (result.status !== "confirmation_required") {
      throw new Error("a bank payee needs the passkey");
    }
    const confirmed = await send(
      "POST",
      `${base()}/changes/${result.challengeId}/confirm`,
      {
        change: result.change,
        response: paying.passkey.sign(result.options, TEST_ORIGIN),
      },
    );
    const payee = await dataOf<Payee>(confirmed);

    // #then
    expect({
      requested: requested.status,
      confirmed: confirmed.ok,
      bank: payee.details?.method === "bank" ? payee.details.bankCode : null,
      calls,
    }).toEqual({
      requested: 200,
      confirmed: true,
      bank: "PRIEKENX",
      calls: [],
    });
  });

  it("refuses a bank the catalogue doesn't know, in words that name no provider", async () => {
    // #when
    const response = await send("POST", base(), bankPayee("NOTABANK"));
    const body = (await response.json()) as { error: { message: string } };

    // #then
    expect({ status: response.status, calls }).toEqual({
      status: 400,
      calls: [],
    });
    expect(body.error.message).not.toMatch(/paycrest|pretium/i);
  });
});
