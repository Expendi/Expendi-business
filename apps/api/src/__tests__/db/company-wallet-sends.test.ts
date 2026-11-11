import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { NewCompanyWalletSend } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { DatabaseService } from "../../db/client.js";
import { companyWalletSends } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { randomNearAccount, randomNearTxHash } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let fixture: IsolationFixture;
let walletA: TestWallet;
let walletB: TestWallet;
let nextNonce = 1n;

const nearWallet = () => ({
  privyWalletId: `near-wallet-${randomUUID()}`,
  accountId: randomNearAccount(),
});

function send(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewCompanyWalletSend> = {},
): NewCompanyWalletSend {
  nextNonce += 1n;
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    sendKey: `payout-${randomUUID()}`,
    kind: "transfer",
    senderAccountId: wallet.address,
    receiverAccountId: "payee.near",
    usdcAmount: 5_000_000n,
    nonce: nextNonce,
    maxBlockHeight: 1_000n,
    ...overrides,
  };
}

/** A send that has finished, so it doesn't hold its wallet. */
const ran = (overrides: Partial<NewCompanyWalletSend> = {}) => ({
  status: "executed" as const,
  signedDelegate: "c2lnbmVk",
  txHash: randomNearTxHash(),
  blockHeight: 900n,
  ...overrides,
});

const insertAs = (company: TestCompany, row: NewCompanyWalletSend) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(companyWalletSends).values(row).returning(),
  );

async function companyWithWallet() {
  const company = await createCompany(db);
  return {
    company,
    wallet: await createActiveNearWallet(db, company, nearWallet()),
  };
}

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  fixture = await createIsolationFixture(db);
  [walletA, walletB] = await Promise.all([
    createActiveNearWallet(db, fixture.companyA, nearWallet()),
    createActiveNearWallet(db, fixture.companyB, nearWallet()),
  ]);
  await insertAs(fixture.companyA, send(fixture.companyA, walletA, ran()));
  await insertAs(fixture.companyB, send(fixture.companyB, walletB, ran()));
});

afterAll(async () => {
  await runtime.dispose();
});

describe("company_wallet_sends", () => {
  it("is isolated between companies", async () => {
    await expectTableIsolation(fixture, "company_wallet_sends");
  });

  it("can't record a send against another company's wallet", async () => {
    // #when
    const crossed = insertAs(
      fixture.companyA,
      send(fixture.companyA, walletB, ran()),
    );

    // #then
    await expect(crossed).rejects.toMatchObject({
      cause: { constraint: "company_wallet_sends_wallet_organization_fk" },
    });
  });

  it.each([["reserved" as const], ["signed" as const]])(
    "allows one %s send per wallet at a time",
    async (status) => {
      // #given
      const { company, wallet } = await companyWithWallet();
      const inFlight = { status, signedDelegate: "c2lnbmVk" };
      await insertAs(company, send(company, wallet, inFlight));

      // #when
      const second = insertAs(company, send(company, wallet));

      // #then
      await expect(second).rejects.toMatchObject({
        cause: { constraint: "company_wallet_sends_one_in_flight_per_wallet" },
      });
    },
  );

  it.each([
    ["executed" as const, ran()],
    ["failed" as const, ran({ status: "failed" })],
    ["expired" as const, { status: "expired" as const }],
    ["refused" as const, { status: "refused" as const }],
  ])("frees the wallet once its send is %s", async (_status, finished) => {
    // #given
    const { company, wallet } = await companyWithWallet();
    await insertAs(company, send(company, wallet, finished));

    // #when
    const [next] = await insertAs(company, send(company, wallet));

    // #then
    expect(next?.status).toBe("reserved");
  });

  it.each([
    ["has run", ran()],
    ["ran and moved nothing", ran({ status: "failed" })],
  ])("never lets a key be used again once its send %s", async (_name, done) => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const sendKey = `payout-${randomUUID()}`;
    await insertAs(company, send(company, wallet, { ...done, sendKey }));

    // #when
    const again = insertAs(company, send(company, wallet, { sendKey }));

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "company_wallet_sends_live_key_unique" },
    });
  });

  it.each([["expired" as const], ["refused" as const]])(
    "lets a key be used again after its send %s",
    async (status) => {
      // #given
      const { company, wallet } = await companyWithWallet();
      const sendKey = `payout-${randomUUID()}`;
      await insertAs(company, send(company, wallet, { status, sendKey }));

      // #when
      const [again] = await insertAs(
        company,
        send(company, wallet, { sendKey }),
      );

      // #then
      expect(again?.sendKey).toBe(sendKey);
    },
  );

  it("lets two companies use the same key", async () => {
    // #given
    const first = await companyWithWallet();
    const second = await companyWithWallet();
    const sendKey = "payout-1";
    await insertAs(
      first.company,
      send(first.company, first.wallet, { sendKey }),
    );

    // #when
    const [other] = await insertAs(
      second.company,
      send(second.company, second.wallet, { sendKey }),
    );

    // #then
    expect(other?.sendKey).toBe(sendKey);
  });

  it("never gives two sends from one wallet the same nonce", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    await insertAs(
      company,
      send(company, wallet, { status: "expired", nonce: 77n }),
    );

    // #when
    const reused = insertAs(company, send(company, wallet, { nonce: 77n }));

    // #then
    await expect(reused).rejects.toMatchObject({
      cause: { constraint: "company_wallet_sends_wallet_nonce_unique" },
    });
  });

  it.each([
    [
      "signed without its signed bytes",
      { status: "signed" as const },
      "company_wallet_sends_signed_is_saved",
    ],
    [
      "executed without its transaction",
      { status: "executed" as const, signedDelegate: "c2lnbmVk" },
      "company_wallet_sends_ran_has_transaction",
    ],
    ["for nothing", { usdcAmount: 0n }, "company_wallet_sends_amount_positive"],
    [
      "a plain transfer with a message",
      { msg: "quote-1" },
      "company_wallet_sends_msg_matches_kind",
    ],
    [
      "a transfer call without a message",
      { kind: "transfer_call" as const },
      "company_wallet_sends_msg_matches_kind",
    ],
    [
      "a plain transfer with a token",
      { tokenId: "nep141:base-0xabc.omft.near" },
      "company_wallet_sends_token_matches_kind",
    ],
    [
      "an Intents transfer without a token",
      { kind: "intents_transfer" as const },
      "company_wallet_sends_token_matches_kind",
    ],
  ])("rejects a send that is %s", async (_name, overrides, constraint) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(company, send(company, wallet, overrides));

    // #then
    await expect(insert).rejects.toMatchObject({ cause: { constraint } });
  });

  it("accepts an Intents transfer that names its token", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [saved] = await insertAs(
      company,
      send(company, wallet, {
        kind: "intents_transfer",
        tokenId: "nep141:base-0xabc.omft.near",
      }),
    );

    // #then
    expect(saved).toMatchObject({
      kind: "intents_transfer",
      tokenId: "nep141:base-0xabc.omft.near",
    });
  });

  it("can't be deleted by the API", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const [saved] = await insertAs(company, send(company, wallet, ran()));

    // #when
    const remove = runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .delete(companyWalletSends)
          .where(eq(companyWalletSends.id, saved?.id ?? "")),
    );

    // #then
    await expect(remove).rejects.toMatchObject({
      cause: { code: "42501" },
    });
  });
});
