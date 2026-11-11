import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { UsdcPayoutRequest } from "../../services/payout/payout-service.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  organizations,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmAllowlistChange,
  requestAllowlistChange,
} from "../../services/allowlist/allowlist.js";
import { approvePayouts } from "../../services/payout/approve.js";
import { fundPayout } from "../../services/payout/fund.js";
import {
  confirmOnchainPayouts,
  MAX_SEND_ATTEMPTS,
  SEND_UNCLEAR_AFTER_MS,
} from "../../services/payout/onchain.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { makeFakePaycrest, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
  nearUsdcBill,
  registeredNearAccount,
  savedSends,
} from "../helpers/near-usdc-payouts.js";
import { randomNearAccount } from "../helpers/near.js";
import {
  allowlistAddress,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

// Serial: the confirmation job follows every company's USDC payouts, and
// here it also sends the ones waiting their turn, so run beside other files
// it would send theirs to this file's chain.

const AMOUNT = 25n * USDC;
const OPENING_BALANCE = 100n * USDC;

const fakes = makeNearUsdcFakes();
const { chain, privy } = fakes;
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let paying: NearUsdcPayingCompany;
let payee: string;
let payeeListingId: string;

beforeAll(async () => {
  runtime = makeTestRuntime({ ...fakes.layers, paycrest: paycrest.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  paying = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    OPENING_BALANCE,
  );
  payee = registeredNearAccount(fakes);
  payeeListingId = await allowlistAddress(
    runtime,
    paying,
    payee,
    "Supplier",
    "near",
  );
});

const bill = (overrides: Partial<UsdcPayoutRequest> = {}) =>
  nearUsdcBill(payee, overrides);

const billTo = (address: string) =>
  nearUsdcBill(address, {
    recipient: {
      method: "usdc",
      chain: "near",
      address,
      accountName: "Acme Ltd",
    },
  });

const pay = async (request: UsdcPayoutRequest = bill()): Promise<Payout> => {
  const [payout] = await payClaims(runtime, db, paying, [request]);
  if (!payout) throw new Error("nothing was prepared");
  return payout;
};

/** Prepared and approved with the passkey, but not yet funded. */
async function approved(request: UsdcPayoutRequest = bill()): Promise<Payout> {
  const [prepared] = await runtime.runPromise(
    preparePayouts({
      organizationId: paying.company.organizationId,
      actor: { type: "user", id: paying.company.admin.id },
      requests: [request],
    }),
  );
  if (!prepared) throw new Error("nothing was prepared");
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      payoutIds: [prepared.id],
    }),
  );
  await runtime.runPromise(
    approvePayouts({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: approval.challengeId,
      response: paying.passkey.sign(approval.options, TEST_ORIGIN),
    }),
  );
  return prepared;
}

const fund = (payout: Payout) =>
  runtime.runPromise(
    fundPayout({
      organizationId: paying.company.organizationId,
      payoutId: payout.id,
    }),
  );

const runJob = () => runtime.runPromise(confirmOnchainPayouts(500));
const reload = (payout: Payout) => readPayout(db, paying.company, payout.id);
const sends = () => savedSends(db, paying.company);
const paidToPayee = (account = payee) => chain.state.usdcBalanceOf(account);
const signings = () => privy.state.nearSigningRequestsFor(paying.privyWalletId);

async function removePayeeFromAllowlist(): Promise<void> {
  const change = { action: "remove", addressId: payeeListingId } as const;
  const challenge = await runtime.runPromise(
    requestAllowlistChange({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      change,
    }),
  );
  await runtime.runPromise(
    confirmAllowlistChange({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: challenge.challengeId,
      response: paying.passkey.sign(challenge.options, TEST_ORIGIN),
      change,
    }),
  );
}

const inCompany = <T>(work: Parameters<typeof runInScope<T>>[2]): Promise<T> =>
  runInScope(db, { organizationId: paying.company.organizationId }, work);

const debits = (payout: Payout) =>
  inCompany((tx) =>
    tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.payoutId, payout.id)),
  );

/** What a payout that moved nothing must look like, whatever stopped it. */
async function nothingMoved(payout: Payout, account = payee) {
  return {
    paid: paidToPayee(account),
    debits: (await debits(payout)).length,
    ledger: await ledgerBalance(db, paying.company),
  };
}

const NOTHING_MOVED = { paid: 0n, debits: 0, ledger: OPENING_BALANCE };

describe("paying a USDC payee on NEAR", () => {
  it("moves exactly the amount from the company wallet to the payee, once", async () => {
    // #when
    const payout = await pay();

    // #then
    const [send, ...others] = await sends();
    expect({
      status: payout.status,
      provider: payout.provider,
      paid: paidToPayee(),
      left: chain.state.usdcBalanceOf(paying.wallet.address),
      send: send && {
        status: send.status,
        key: send.sendKey,
        to: send.receiverAccountId,
        amount: send.usdcAmount,
      },
      otherSends: others.length,
      ordersAtPaycrest: paycrest.state.created.length,
    }).toEqual({
      status: "paying",
      provider: "onchain",
      paid: AMOUNT,
      left: OPENING_BALANCE - AMOUNT,
      send: {
        status: "executed",
        key: `payout-${payout.id}`,
        to: payee,
        amount: AMOUNT,
      },
      otherSends: 0,
      ordersAtPaycrest: 0,
    });
  });

  it("debits the ledger on NEAR when the send has run", async () => {
    // #when
    const payout = await pay();

    // #then
    const [send] = await sends();
    expect({
      rows: (await debits(payout)).map((row) => ({
        type: row.type,
        chain: row.chain,
        usdcAmount: row.usdcAmount,
        txHash: row.txHash,
        counterparty: row.counterpartyAddress,
      })),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      rows: [
        {
          type: "payout",
          chain: "near",
          usdcAmount: -AMOUNT,
          txHash: send?.txHash,
          counterparty: payee,
        },
      ],
      ledger: OPENING_BALANCE - AMOUNT,
    });
  });

  it("keeps the transaction hash exactly as the chain gave it, capitals included", async () => {
    // #given
    const payout = await pay();
    const [send] = await sends();
    const onChain = chain.state.broadcasts.at(-1);

    // #when
    await runJob();

    // #then
    const paid = await reload(payout);
    const [debit] = await debits(payout);
    expect({
      mixedCase: onChain !== onChain?.toLowerCase(),
      send: send?.txHash,
      payout: paid.txHash,
      reference: paid.providerReference,
      ledger: debit?.txHash,
    }).toEqual({
      mixedCase: true,
      send: onChain,
      payout: onChain,
      reference: onChain,
      ledger: onChain,
    });
  });

  it("is marked paid once the chain shows the transfer from the wallet to the payee for the amount", async () => {
    // #given
    const payout = await pay();

    // #when
    const summary = await runJob();

    // #then
    const paid = await reload(payout);
    expect({
      status: paid.status,
      paidAt: paid.paidAt !== null,
      confirmed: summary.confirmed,
      errors: summary.errors,
    }).toEqual({ status: "paid", paidAt: true, confirmed: 1, errors: 0 });
  });

  it.each([
    [
      "another amount",
      (log: string) => log.replace(`"${AMOUNT}"`, `"${AMOUNT - 1n}"`),
    ],
    [
      "another receiver",
      (log: string) => log.replace(payee, randomNearAccount()),
    ],
    [
      "another sender",
      (log: string, wallet: string) => log.replace(wallet, randomNearAccount()),
    ],
  ])(
    "goes to review when the chain shows %s than the payout sends",
    async (_what, tamper) => {
      // #given the outcome the chain reports for the payout's transaction
      const payout = await pay();
      const txHash = payout.txHash ?? "";
      const outcome = chain.state.outcomes.get(txHash);
      if (!outcome) throw new Error("no outcome on the fake chain");
      chain.state.outcomes.set(txHash, {
        ...outcome,
        receipts: outcome.receipts.map((receipt) => ({
          ...receipt,
          logs: receipt.logs.map((log) => tamper(log, paying.wallet.address)),
        })),
      });

      // #when
      await runJob();

      // #then
      expect((await reload(payout)).status).toBe("needs_review");
    },
  );

  it("isn't marked paid while the chain can't show the transaction yet", async () => {
    // #given
    const payout = await pay();
    const txHash = payout.txHash ?? "";
    const outcome = chain.state.outcomes.get(txHash);
    chain.state.outcomes.delete(txHash);

    // #when
    await runJob();
    const before = (await reload(payout)).status;
    if (outcome) chain.state.outcomes.set(txHash, outcome);
    await runJob();

    // #then
    expect({ before, after: (await reload(payout)).status }).toEqual({
      before: "paying",
      after: "paid",
    });
  });
});

describe("the allowlist, re-checked before a NEAR payout is sent", () => {
  it("fails the payout when the address was removed after approval", async () => {
    // #given
    const payout = await approved();
    await removePayeeFromAllowlist();
    const before = signings();

    // #when
    const funded = await fund(payout);

    // #then
    expect({
      status: funded.status,
      reason: funded.failureReason,
      signings: signings() - before,
      sends: (await sends()).length,
      ...(await nothingMoved(payout)),
    }).toEqual({
      status: "failed",
      reason: "The address was removed from the allowlist. Nothing was sent.",
      signings: 0,
      sends: 0,
      ...NOTHING_MOVED,
    });
  });

  it("fails a payout whose address was removed while it waited for an expired send to be replaced", async () => {
    // #given a send that never reached a block and has expired
    chain.state.nextBroadcasts("drop");
    const payout = await pay();
    fakes.passExpiry();
    await removePayeeFromAllowlist();
    const before = signings();

    // #when
    await runJob();

    // #then
    const failed = await reload(payout);
    expect({
      status: failed.status,
      reason: failed.failureReason,
      signings: signings() - before,
      ...(await nothingMoved(payout)),
    }).toEqual({
      status: "failed",
      reason: "The address was removed from the allowlist. Nothing was sent.",
      signings: 0,
      ...NOTHING_MOVED,
    });
  });

  it("fails a waiting payout once payouts are paused", async () => {
    // #given
    chain.state.nextBroadcasts("drop");
    const payout = await pay();
    fakes.passExpiry();
    await inCompany((tx) =>
      tx
        .update(organizations)
        .set({ payoutsPaused: true })
        .where(eq(organizations.id, paying.company.organizationId)),
    );

    // #when
    await runJob();

    // #then
    const failed = await reload(payout);
    expect({
      status: failed.status,
      reason: failed.failureReason,
      ...(await nothingMoved(payout)),
    }).toEqual({
      status: "failed",
      reason: "Payouts were paused. Nothing was sent.",
      ...NOTHING_MOVED,
    });
  });
});

describe("a payee who can't receive USDC yet", () => {
  it("has a new implicit account created and registered by the gas relayer, then is paid", async () => {
    // #given an account that isn't on chain at all
    const fresh = randomNearAccount();
    await allowlistAddress(runtime, paying, fresh, "New supplier", "near");

    // #when
    const payout = await pay(billTo(fresh));

    // #then
    expect({
      status: payout.status,
      exists: chain.state.accounts.has(fresh),
      registered: chain.state.registered.has(fresh),
      paid: paidToPayee(fresh),
    }).toEqual({
      status: "paying",
      exists: true,
      registered: true,
      paid: AMOUNT,
    });
  });

  it("is registered when the account exists but USDC doesn't know it", async () => {
    // #given
    const unregistered = randomNearAccount();
    chain.state.createAccount(unregistered);
    await allowlistAddress(runtime, paying, unregistered, "Supplier", "near");

    // #when
    const payout = await pay(billTo(unregistered));

    // #then
    expect({ status: payout.status, paid: paidToPayee(unregistered) }).toEqual({
      status: "paying",
      paid: AMOUNT,
    });
  });

  it("fails, with nothing signed, when a named account doesn't exist", async () => {
    // #given
    const named = `supplier-${randomBytes(4).toString("hex")}.near`;
    await allowlistAddress(runtime, paying, named, "Supplier", "near");
    const before = signings();

    // #when
    const payout = await pay(billTo(named));

    // #then
    expect({
      status: payout.status,
      reason: payout.failureReason,
      signings: signings() - before,
      sends: (await sends()).length,
      ...(await nothingMoved(payout, named)),
    }).toEqual({
      status: "failed",
      reason: `The NEAR account ${named} doesn't exist, and a named account can't be created for someone else. Check the account with the recipient, correct it and pay again. Nothing was sent.`,
      signings: 0,
      sends: 0,
      ...NOTHING_MOVED,
    });
  });

  it("fails, with nothing signed, when a named account isn't registered with USDC", async () => {
    // #given
    const named = `supplier-${randomBytes(4).toString("hex")}.near`;
    chain.state.createAccount(named);
    await allowlistAddress(runtime, paying, named, "Supplier", "near");
    const before = signings();

    // #when
    const payout = await pay(billTo(named));

    // #then
    expect({
      status: payout.status,
      explains: payout.failureReason?.includes(
        "isn't registered with the USDC contract on NEAR",
      ),
      signings: signings() - before,
      ...(await nothingMoved(payout, named)),
    }).toEqual({
      status: "failed",
      explains: true,
      signings: 0,
      ...NOTHING_MOVED,
    });
  });

  it("pays a named account that is registered", async () => {
    // #given
    const named = `supplier-${randomBytes(4).toString("hex")}.near`;
    chain.state.fundWithUsdc(named, 0n);
    await allowlistAddress(runtime, paying, named, "Supplier", "near");

    // #when
    const payout = await pay(billTo(named));

    // #then
    expect({ status: payout.status, paid: paidToPayee(named) }).toEqual({
      status: "paying",
      paid: AMOUNT,
    });
  });

  it("waits, with nothing signed, while the chain can't say whether the payee is registered", async () => {
    // #given
    chain.state.failNext("usdcStorageRegistered");
    const before = signings();

    // #when
    const payout = await pay();
    const waiting = { status: payout.status, signings: signings() - before };
    await runJob();

    // #then
    expect({ waiting, after: (await reload(payout)).status }).toEqual({
      waiting: { status: "funding", signings: 0 },
      after: "paid",
    });
  });
});

describe("a send the company wallet refuses", () => {
  it("fails the payout when the amount is over the wallet's cap by the time it is sent", async () => {
    // #given the cap is lowered after the payout was approved
    const payout = await approved();
    await inCompany((tx) =>
      tx
        .update(wallets)
        .set({ perTransactionMaxUsdc: AMOUNT - 1n })
        .where(eq(wallets.id, paying.wallet.id)),
    );
    const before = signings();

    // #when
    const funded = await fund(payout);

    // #then
    expect({
      status: funded.status,
      reason: funded.failureReason,
      signings: signings() - before,
      ...(await nothingMoved(payout)),
    }).toEqual({
      status: "failed",
      reason:
        "The wallet refused the transfer (it is over the wallet's per-transaction maximum). Nothing was sent.",
      signings: 0,
      ...NOTHING_MOVED,
    });
  });

  it("fails the payout when Privy refuses to sign", async () => {
    // #given
    privy.state.nextNearSignings("refused");

    // #when
    const payout = await pay();

    // #then
    expect({
      status: payout.status,
      reason: payout.failureReason,
      broadcasts: (await sends()).flatMap((send) => send.relayTxHashes).length,
      ...(await nothingMoved(payout)),
    }).toEqual({
      status: "failed",
      reason: "The wallet refused the transfer. Nothing was sent.",
      broadcasts: 0,
      ...NOTHING_MOVED,
    });
  });

  it("fails the payout when the chain runs the send but the USDC contract moves nothing", async () => {
    // #given the wallet's USDC is gone by the time the send runs
    chain.state.balances.set(paying.wallet.address, 0n);

    // #when
    const payout = await pay();

    // #then
    expect({
      status: payout.status,
      ...(await nothingMoved(payout)),
    }).toEqual({ status: "failed", ...NOTHING_MOVED });
  });

  it("isn't sent at all from a company wallet that is still on Base", async () => {
    // #given
    await inCompany((tx) =>
      tx
        .update(wallets)
        .set({ chain: "base" })
        .where(eq(wallets.id, paying.wallet.id)),
    );
    const before = signings();

    // #when
    const payout = await pay();

    // #then
    expect({
      status: payout.status,
      signings: signings() - before,
      ...(await nothingMoved(payout)),
    }).toEqual({ status: "failed", signings: 0, ...NOTHING_MOVED });
  });
});

describe("a send whose outcome is unclear", () => {
  it("leaves the payout funding, undebited, and is never sent again while the chain is silent", async () => {
    // #given the chain runs the send but doesn't show its outcome
    chain.state.nextBroadcasts("withhold");
    const before = signings();
    const broadcastsBefore = chain.state.broadcasts.length;

    // #when
    const payout = await pay();
    await runJob();
    await runJob();

    // #then
    const waiting = await reload(payout);
    expect({
      status: waiting.status,
      txHash: waiting.txHash,
      debits: (await debits(payout)).length,
      signings: signings() - before,
      broadcasts: chain.state.broadcasts.length - broadcastsBefore,
    }).toEqual({
      status: "funding",
      txHash: null,
      debits: 0,
      signings: 1,
      broadcasts: 1,
    });
  });

  it("is paid and debited once the chain shows the send ran, without sending again", async () => {
    // #given
    chain.state.nextBroadcasts("withhold");
    const before = signings();
    const payout = await pay();
    chain.state.release();

    // #when
    await runJob();

    // #then
    const paid = await reload(payout);
    expect({
      status: paid.status,
      paid: paidToPayee(),
      debits: (await debits(payout)).map((row) => row.usdcAmount),
      signings: signings() - before,
    }).toEqual({
      status: "paid",
      paid: AMOUNT,
      debits: [-AMOUNT],
      signings: 1,
    });
  });

  it("goes to review when the chain still hasn't answered long after the send expired", async () => {
    // #given a send the chain keeps silent about, signed long ago
    chain.state.nextBroadcasts("withhold");
    const before = signings();
    const payout = await pay();
    await inCompany((tx) =>
      tx
        .update(companyWalletSends)
        .set({ createdAt: new Date(Date.now() - SEND_UNCLEAR_AFTER_MS - 1000) })
        .where(eq(companyWalletSends.sendKey, `payout-${payout.id}`)),
    );

    // #when
    await runJob();
    const reviewed = await reload(payout);
    await runJob();

    // #then
    expect({
      status: reviewed.status,
      reason: reviewed.failureReason,
      after: (await reload(payout)).status,
      signings: signings() - before,
    }).toEqual({
      status: "needs_review",
      reason:
        "The transfer's outcome is unknown. Check the chain before doing anything; never send again.",
      after: "needs_review",
      signings: 1,
    });
    chain.state.release();
  });

  it("is signed again, and paid once, when Privy's reply to the first signing was lost", async () => {
    // #given
    privy.state.nextNearSignings("unavailable");
    const payout = await pay();
    const waiting = payout.status;

    // #when
    await runJob();

    // #then
    expect({
      waiting,
      status: (await reload(payout)).status,
      paid: paidToPayee(),
      sends: (await sends()).map((send) => send.status),
    }).toEqual({
      waiting: "funding",
      status: "paid",
      paid: AMOUNT,
      sends: ["executed"],
    });
  });
});

describe("a saved send that doesn't match its payout", () => {
  it("sends the payout to review instead of failing it or sending again", async () => {
    // #given a send saved for the payout, whose amount the payout no longer has
    privy.state.nextNearSignings("unavailable");
    const payout = await pay();
    await updatePayout(db, paying.company, payout.id, {
      amountToTransferUsdc: AMOUNT - 1n,
    });
    const before = signings();

    // #when
    await runJob();

    // #then
    expect({
      status: (await reload(payout)).status,
      signings: signings() - before,
      paid: paidToPayee(),
    }).toEqual({ status: "needs_review", signings: 0, paid: 0n });
  });
});

describe("a send that expired without running", () => {
  it("is replaced by a new send, and the payee is paid exactly once", async () => {
    // #given the first send never reaches a block
    chain.state.nextBroadcasts("drop");
    const payout = await pay();
    const waiting = payout.status;
    fakes.passExpiry();

    // #when
    await runJob();

    // #then
    const paid = await reload(payout);
    const all = await sends();
    expect({
      waiting,
      status: paid.status,
      paid: paidToPayee(),
      debits: (await debits(payout)).map((row) => row.usdcAmount),
      sends: all.map((send) => send.status),
      sameKey: new Set(all.map((send) => send.sendKey)).size,
      txHash: paid.txHash === all[1]?.txHash,
    }).toEqual({
      waiting: "funding",
      status: "paid",
      paid: AMOUNT,
      debits: [-AMOUNT],
      sends: ["expired", "executed"],
      sameKey: 1,
      txHash: true,
    });
  });

  it("isn't replaced before its expiry has passed", async () => {
    // #given
    chain.state.nextBroadcasts("drop");
    const before = signings();
    const payout = await pay();

    // #when
    await runJob();

    // #then
    expect({
      status: (await reload(payout)).status,
      signings: signings() - before,
      sends: (await sends()).map((send) => send.status),
    }).toEqual({ status: "funding", signings: 1, sends: ["signed"] });
    fakes.passExpiry();
    await runJob();
  });

  it(`fails the payout, with nothing sent, after ${MAX_SEND_ATTEMPTS} sends expired`, async () => {
    // #given
    chain.state.nextBroadcasts(
      ...Array.from({ length: MAX_SEND_ATTEMPTS }, () => "drop" as const),
    );
    const payout = await pay();

    // #when
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      fakes.passExpiry();
      await runJob();
    }

    // #then
    const failed = await reload(payout);
    expect({
      status: failed.status,
      reason: failed.failureReason,
      sends: (await sends()).map((send) => send.status),
      ...(await nothingMoved(payout)),
    }).toEqual({
      status: "failed",
      reason: `The transfer expired ${MAX_SEND_ATTEMPTS} times before the chain ran it. Nothing was sent.`,
      sends: Array.from({ length: MAX_SEND_ATTEMPTS }, () => "expired"),
      ...NOTHING_MOVED,
    });
  });
});

describe("several NEAR payouts from one company wallet", () => {
  const RUN_SIZE = 20;
  const EACH = 2n * USDC;

  const run = () =>
    Array.from({ length: RUN_SIZE }, () => bill({ amountUsdc: EACH }));

  it("keeps the others waiting, not failed, while one send is in flight", async () => {
    // #given the first send's outcome is withheld
    chain.state.nextBroadcasts("withhold");
    const before = signings();

    // #when
    const paid = await payClaims(runtime, db, paying, run());
    await runJob();

    // #then
    const statuses = await Promise.all(
      paid.map(async (payout) => (await reload(payout)).status),
    );
    expect({
      statuses: [...new Set(statuses)],
      signings: signings() - before,
      sends: (await sends()).length,
    }).toEqual({ statuses: ["funding"], signings: 1, sends: 1 });
    chain.state.release();
    await runJob();
  });

  it("pays a run of 20 one after another with no one stepping in", async () => {
    // #given
    chain.state.nextBroadcasts("withhold");
    const paid = await payClaims(runtime, db, paying, run());
    chain.state.release();

    // #when
    const summary = await runJob();

    // #then
    const after = await Promise.all(paid.map(reload));
    const all = await sends();
    expect({
      statuses: [...new Set(after.map((payout) => payout.status))],
      paidToPayee: paidToPayee(),
      ledger: await ledgerBalance(db, paying.company),
      sends: all.length,
      executed: all.filter((send) => send.status === "executed").length,
      distinctTransactions: new Set(after.map((payout) => payout.txHash)).size,
      sent: summary.sent,
      errors: summary.errors,
    }).toEqual({
      statuses: ["paid"],
      paidToPayee: BigInt(RUN_SIZE) * EACH,
      ledger: OPENING_BALANCE - BigInt(RUN_SIZE) * EACH,
      sends: RUN_SIZE,
      executed: RUN_SIZE,
      distinctTransactions: RUN_SIZE,
      sent: RUN_SIZE,
      errors: 0,
    });
  });

  it("pays each exactly once when the same payout is funded from two places at once", async () => {
    // #given
    const payout = await approved();

    // #when the request and the job both drive it
    await Promise.all([fund(payout), runJob(), runJob()]);
    await runJob();

    // #then
    expect({
      status: (await reload(payout)).status,
      paid: paidToPayee(),
      sends: (await sends()).map((send) => send.status),
      debits: (await debits(payout)).length,
    }).toEqual({
      status: "paid",
      paid: AMOUNT,
      sends: ["executed"],
      debits: 1,
    });
  });
});
