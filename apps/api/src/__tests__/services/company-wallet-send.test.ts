import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { companyWalletSends, wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { ONE_CLICK_FUND_IN_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import {
  DELEGATE_TTL_BLOCKS,
  delegateVerdict,
  sendIntentsTokenFromCompanyWallet,
  sendUsdcFromCompanyWallet,
  sendUsdcFromCompanyWalletWithCall,
  settleCompanyWalletSend,
} from "../../services/wallet/company-wallet-send.js";
import {
  createActiveNearWallet,
  createActiveWallet,
  createCompany,
} from "../helpers/db.js";
import { makeFakePrivyWallets } from "../helpers/fakes.js";
import {
  ftTransferLog,
  makeFakeNearRpc,
  mtTransferLog,
  nearOutcome,
  nearRelayerOnFakeChain,
  randomNearAccount,
  TEST_INTENTS_CONTRACT,
  TEST_NEAR_CHAIN,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const CAP = 100_000_000n;
const OPENING_BALANCE = 500_000_000n;
const AMOUNT = 20_000_000n;

const privy = makeFakePrivyWallets();
const chain = makeFakeNearRpc();
const relayer = nearRelayerOnFakeChain(privy.state, chain);
let runtime: AppRuntime;
let db: Database;
let company: TestCompany;
let companyAccount: string;
let companyPrivyWalletId: string;
let payee: string;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    nearRpc: chain.layer,
    nearRelayer: relayer.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
});

beforeEach(async () => {
  chain.state.transferCallReceiverKeeps = true;
  company = await createCompany(db);
  const nearWallet = privy.state.addNearWallet(company.organizationId);
  companyAccount = nearWallet.accountId;
  companyPrivyWalletId = nearWallet.privyWalletId;
  chain.state.fundWithUsdc(companyAccount, OPENING_BALANCE);
  await createActiveNearWallet(db, company, nearWallet, CAP);
  payee = randomNearAccount();
  chain.state.fundWithUsdc(payee, 0n);
});

afterAll(async () => {
  await runtime.dispose();
});

const send = (
  overrides: Partial<Parameters<typeof sendUsdcFromCompanyWallet>[0]> = {},
) =>
  runtime.runPromiseExit(
    sendUsdcFromCompanyWallet({
      organizationId: company.organizationId,
      sendKey: "payout-1",
      to: payee,
      amount: AMOUNT,
      ...overrides,
    }),
  );

type SendExit = Awaited<ReturnType<typeof send>>;

const failure = (exit: SendExit) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))
    : null;

const tag = (exit: SendExit) =>
  Exit.isSuccess(exit) ? "sent" : (failure(exit)?._tag ?? "defect");

const savedSends = () =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .select()
      .from(companyWalletSends)
      .where(eq(companyWalletSends.organizationId, company.organizationId))
      .orderBy(asc(companyWalletSends.nonce)),
  );

const paid = () => chain.state.usdcBalanceOf(payee);

const companySignings = () =>
  privy.state.nearSigningRequestsFor(companyPrivyWalletId);

/**
 * How often, from here on, Privy is asked to sign for the company wallet
 * and the chain is handed a transaction.
 */
function watching() {
  const signings = companySignings();
  const broadcasts = chain.state.broadcasts.length;
  return () => ({
    signings: companySignings() - signings,
    broadcasts: chain.state.broadcasts.length - broadcasts,
  });
}

const passExpiry = () => {
  chain.state.height += DELEGATE_TTL_BLOCKS + 1n;
};

describe("sendUsdcFromCompanyWallet", () => {
  it("moves the USDC to the payee and reports the relayer transaction", async () => {
    // #when
    const exit = await send();

    // #then
    const [saved] = await savedSends();
    expect({
      paid: paid(),
      left: chain.state.usdcBalanceOf(companyAccount),
      receipt: Exit.isSuccess(exit) ? exit.value : null,
    }).toEqual({
      paid: AMOUNT,
      left: OPENING_BALANCE - AMOUNT,
      receipt: {
        sendId: saved?.id,
        txHash: chain.state.broadcasts.at(-1),
        blockHeight: saved?.blockHeight,
      },
    });
  });

  it("saves the send with its nonce, its expiry about two minutes ahead, and the transaction that ran it", async () => {
    // #given
    const heightBefore = chain.state.height;
    const nonceBefore = chain.state.nonceOf(companyAccount) ?? 0n;

    // #when
    await send();

    // #then
    const [saved, ...others] = await savedSends();
    expect(others).toEqual([]);
    expect(saved).toMatchObject({
      status: "executed",
      kind: "transfer",
      sendKey: "payout-1",
      senderAccountId: companyAccount,
      receiverAccountId: payee,
      usdcAmount: AMOUNT,
      nonce: nonceBefore + 1n,
      maxBlockHeight: heightBefore + 200n,
      relayTxHashes: [chain.state.broadcasts.at(-1)],
      txHash: chain.state.broadcasts.at(-1),
    });
  });

  it("is paid for by the gas relayer, not the company wallet", async () => {
    // #when
    await send();

    // #then
    const outcome = chain.state.outcomes.get(
      chain.state.broadcasts.at(-1) ?? "",
    );
    expect({
      signer: outcome?.signerId,
      receiver: outcome?.receiverId,
    }).toEqual({ signer: relayer.accountId, receiver: companyAccount });
  });

  it("returns the same receipt for the same key without signing or relaying again", async () => {
    // #given
    const first = await send();
    const observed = watching();

    // #when
    const second = await send();

    // #then
    expect({
      same:
        Exit.isSuccess(first) &&
        Exit.isSuccess(second) &&
        first.value.txHash === second.value.txHash,
      paid: paid(),
      ...observed(),
    }).toEqual({ same: true, paid: AMOUNT, signings: 0, broadcasts: 0 });
  });

  it("moves the money once when the same send is asked for several times at once", async () => {
    // #when
    const exits = await Promise.all(Array.from({ length: 4 }, () => send()));

    // #then
    const saved = await savedSends();
    expect({
      paid: paid(),
      sends: saved.length,
      status: saved[0]?.status,
      defects: exits.filter((exit) => tag(exit) === "defect").length,
    }).toEqual({ paid: AMOUNT, sends: 1, status: "executed", defects: 0 });
  });
});

describe("the per-transaction cap", () => {
  it("allows a send of exactly the cap", async () => {
    // #when
    const exit = await send({ amount: CAP });

    // #then
    expect({ outcome: tag(exit), paid: paid() }).toEqual({
      outcome: "sent",
      paid: CAP,
    });
  });

  it("refuses a send one base unit over the cap before asking Privy to sign", async () => {
    // #given
    const observed = watching();

    // #when
    const exit = await send({ amount: CAP + 1n });

    // #then
    const refusal = failure(exit);
    const [saved] = await savedSends();
    expect({
      refusal: refusal?._tag === "SendRefused" && refusal.policyViolation,
      paid: paid(),
      saved: saved?.status,
      signedBytes: saved?.signedDelegate,
      ...observed(),
    }).toEqual({
      refusal: true,
      paid: 0n,
      saved: "refused",
      signedBytes: null,
      signings: 0,
      broadcasts: 0,
    });
  });

  it("checks the cap as it stands when signing, not when the send was first built", async () => {
    // #given a send that was built under the old cap but never got signed
    privy.state.nextNearSignings("unavailable");
    const stalled = await send();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(wallets)
        .set({ perTransactionMaxUsdc: AMOUNT - 1n })
        .where(eq(wallets.organizationId, company.organizationId)),
    );
    const observed = watching();

    // #when
    const retried = await send();

    // #then
    const refusal = failure(retried);
    expect({
      stalled: tag(stalled),
      refusal: refusal?._tag === "SendRefused" && refusal.policyViolation,
      paid: paid(),
      ...observed(),
    }).toEqual({
      stalled: "PrivyWalletError",
      refusal: true,
      paid: 0n,
      signings: 0,
      broadcasts: 0,
    });
  });

  it("uses the company's own cap", async () => {
    // #given another company with a higher cap sends the same amount
    const other = await createCompany(db);
    const otherWallet = privy.state.addNearWallet(other.organizationId);
    chain.state.fundWithUsdc(otherWallet.accountId, OPENING_BALANCE);
    await createActiveNearWallet(db, other, otherWallet, CAP * 2n);

    // #when
    const [capped, allowed] = await Promise.all([
      send({ amount: CAP + 1n }),
      send({ organizationId: other.organizationId, amount: CAP + 1n }),
    ]);

    // #then
    expect({ capped: tag(capped), allowed: tag(allowed) }).toEqual({
      capped: "SendRefused",
      allowed: "sent",
    });
  });
});

describe("a send that is saved before it is relayed", () => {
  it("has its signed bytes and its relayer transaction's hash saved even when the broadcast fails", async () => {
    // #given
    chain.state.nextBroadcasts("reject");

    // #when
    const exit = await send();

    // #then
    const [saved] = await savedSends();
    expect({
      outcome: tag(exit),
      status: saved?.status,
      hasSignedBytes: typeof saved?.signedDelegate === "string",
      relayTxHashes: saved?.relayTxHashes,
      paid: paid(),
    }).toEqual({
      outcome: "SendOutcomeUnknown",
      status: "signed",
      hasSignedBytes: true,
      relayTxHashes: [chain.state.broadcasts.at(-1)],
      paid: 0n,
    });
  });

  it("relays the same saved bytes on a retry, without signing again", async () => {
    // #given
    chain.state.nextBroadcasts("reject");
    await send();
    const [before] = await savedSends();
    const observed = watching();

    // #when
    const retried = await send();

    // #then
    const [after, ...others] = await savedSends();
    expect({
      outcome: tag(retried),
      paid: paid(),
      sends: 1 + others.length,
      sameBytes: after?.signedDelegate === before?.signedDelegate,
      sameNonce: after?.nonce === before?.nonce,
      relays: after?.relayTxHashes.length,
      ...observed(),
    }).toEqual({
      outcome: "sent",
      paid: AMOUNT,
      sends: 1,
      sameBytes: true,
      sameNonce: true,
      relays: 2,
      signings: 0,
      broadcasts: 1,
    });
  });

  it("reports an unknown outcome when the chain ran it but hasn't said so, and never pays twice on retries", async () => {
    // #given the relayer's transaction runs, but its outcome isn't final yet
    chain.state.nextBroadcasts("withhold");
    const first = await send();

    // #when it is retried before and after the chain reports the outcome
    const second = await send();
    chain.state.release();
    const third = await send();

    // #then
    const [saved, ...others] = await savedSends();
    expect({
      outcomes: [tag(first), tag(second), tag(third)],
      paid: paid(),
      sends: 1 + others.length,
      ranIn: saved?.txHash === saved?.relayTxHashes[0],
      signings: companySignings(),
    }).toEqual({
      outcomes: ["SendOutcomeUnknown", "SendOutcomeUnknown", "sent"],
      paid: AMOUNT,
      sends: 1,
      ranIn: true,
      signings: 1,
    });
  });

  it("finds that a send ran even though the node's reply to the broadcast was lost", async () => {
    // #given
    chain.state.nextBroadcasts("lose_reply");
    const first = await send();
    const observed = watching();

    // #when
    const second = await send();

    // #then
    expect({
      outcomes: [tag(first), tag(second)],
      paid: paid(),
      ...observed(),
    }).toEqual({
      outcomes: ["sent", "sent"],
      paid: AMOUNT,
      signings: 0,
      broadcasts: 0,
    });
  });

  it("reports an unknown outcome, not a refusal, when the chain can't be read after signing", async () => {
    // #given
    chain.state.failNext("transactionOutcome", 10);

    // #when
    const exit = await send();
    chain.state.failNext("transactionOutcome", 0);
    const retried = await send();

    // #then
    expect({
      outcomes: [tag(exit), tag(retried)],
      paid: paid(),
    }).toEqual({ outcomes: ["SendOutcomeUnknown", "sent"], paid: AMOUNT });
  });
});

describe("a send that expires", () => {
  it("is final once a block past its expiry shows it never ran, and only then is a new one built", async () => {
    // #given a send whose relayer transactions never reached a block
    chain.state.nextBroadcasts("drop", "drop");
    const dropped = await send();
    const beforeExpiry = await send();
    const sendsBeforeExpiry = (await savedSends()).length;
    passExpiry();

    // #when
    const afterExpiry = await send();

    // #then
    const saved = await savedSends();
    expect({
      outcomes: [tag(dropped), tag(beforeExpiry), tag(afterExpiry)],
      sendsBeforeExpiry,
      statuses: saved.map(({ status }) => status),
      distinctNonces: new Set(saved.map(({ nonce }) => nonce)).size,
      paid: paid(),
    }).toEqual({
      outcomes: ["SendOutcomeUnknown", "SendOutcomeUnknown", "sent"],
      sendsBeforeExpiry: 1,
      statuses: ["expired", "executed"],
      distinctNonces: 2,
      paid: AMOUNT,
    });
  });

  it("relays the same bytes again before its expiry if its first transaction was lost", async () => {
    // #given
    chain.state.nextBroadcasts("drop");
    const dropped = await send();
    const observed = watching();

    // #when
    const retried = await send();

    // #then
    expect({
      outcomes: [tag(dropped), tag(retried)],
      sends: (await savedSends()).length,
      paid: paid(),
      ...observed(),
    }).toEqual({
      outcomes: ["SendOutcomeUnknown", "sent"],
      sends: 1,
      paid: AMOUNT,
      signings: 0,
      broadcasts: 1,
    });
  });

  it("stays unknown, and is never rebuilt, when it expired with its nonce used and no outcome to show for it", async () => {
    // #given it ran, the chain never reported the outcome, and its expiry passed
    chain.state.nextBroadcasts("withhold");
    await send();
    passExpiry();
    const observed = watching();

    // #when
    const exit = await send();

    // #then
    const saved = await savedSends();
    expect({
      outcome: tag(exit),
      statuses: saved.map(({ status }) => status),
      paid: paid(),
      signings: observed().signings,
    }).toEqual({
      outcome: "SendOutcomeUnknown",
      statuses: ["signed"],
      paid: AMOUNT,
      signings: 0,
    });
  });

  it("isn't declared expired by a node that hasn't reached the block being asked about", async () => {
    // #given
    chain.state.nextBroadcasts("drop");
    await send();
    passExpiry();
    chain.state.failNext("accessKeyNonce");

    // #when
    const settled = await runtime.runPromiseExit(
      settleCompanyWalletSend({
        organizationId: company.organizationId,
        sendKey: "payout-1",
      }),
    );

    // #then
    const [saved] = await savedSends();
    expect({
      failed: Exit.isFailure(settled),
      status: saved?.status,
    }).toEqual({ failed: true, status: "signed" });
  });

  it("is dropped without a trace on chain when it expired before it was ever signed", async () => {
    // #given
    privy.state.nextNearSignings("unavailable");
    await send();
    passExpiry();

    // #when
    const exit = await send();

    // #then
    const saved = await savedSends();
    expect({
      outcome: tag(exit),
      statuses: saved.map(({ status }) => status),
      paid: paid(),
    }).toEqual({
      outcome: "sent",
      statuses: ["expired", "executed"],
      paid: AMOUNT,
    });
  });
});

describe("settleCompanyWalletSend", () => {
  it("reports an expired send without building or relaying anything", async () => {
    // #given
    chain.state.nextBroadcasts("drop");
    await send();
    passExpiry();
    const observed = watching();

    // #when
    const settled = await runtime.runPromise(
      settleCompanyWalletSend({
        organizationId: company.organizationId,
        sendKey: "payout-1",
      }),
    );

    // #then
    expect({
      status: settled?.status,
      sends: (await savedSends()).length,
      ...observed(),
    }).toEqual({ status: "expired", sends: 1, signings: 0, broadcasts: 0 });
  });

  it("leaves a send that hasn't expired open", async () => {
    // #given
    chain.state.nextBroadcasts("drop");
    await send();

    // #when
    const settled = await runtime.runPromise(
      settleCompanyWalletSend({
        organizationId: company.organizationId,
        sendKey: "payout-1",
      }),
    );

    // #then
    expect(settled?.status).toBe("signed");
  });

  it("is null for a key nothing was ever sent under", async () => {
    // #when
    const settled = await runtime.runPromise(
      settleCompanyWalletSend({
        organizationId: company.organizationId,
        sendKey: "never-used",
      }),
    );

    // #then
    expect(settled).toBeNull();
  });
});

describe("what Privy and the chain refuse", () => {
  it("fails with nothing sent when Privy refuses to sign, and frees the key", async () => {
    // #given
    privy.state.nextNearSignings("refused");
    const observed = watching();

    // #when
    const refusedExit = await send();
    const broadcastsOnRefusal = observed().broadcasts;
    const retried = await send();

    // #then
    const saved = await savedSends();
    expect({
      outcomes: [tag(refusedExit), tag(retried)],
      broadcastsOnRefusal,
      statuses: saved.map(({ status }) => status),
      paid: paid(),
    }).toEqual({
      outcomes: ["SendRefused", "sent"],
      broadcastsOnRefusal: 0,
      statuses: ["refused", "executed"],
      paid: AMOUNT,
    });
  });

  it("keeps the same reserved send when Privy couldn't be reached, and signs it on the retry", async () => {
    // #given
    privy.state.nextNearSignings("unavailable");
    const first = await send();
    const [reserved] = await savedSends();

    // #when
    const retried = await send();

    // #then
    const [saved, ...others] = await savedSends();
    expect({
      outcomes: [tag(first), tag(retried)],
      reservedAs: reserved?.status,
      sends: 1 + others.length,
      sameNonce: saved?.nonce === reserved?.nonce,
      paid: paid(),
    }).toEqual({
      outcomes: ["PrivyWalletError", "sent"],
      reservedAs: "reserved",
      sends: 1,
      sameNonce: true,
      paid: AMOUNT,
    });
  });

  it("fails for good, without relaying again, when the chain ran it and USDC moved nothing", async () => {
    // #given a payee the USDC contract won't hold a balance for
    const unregistered = randomNearAccount();
    const first = await send({ to: unregistered });
    const observed = watching();

    // #when
    const second = await send({ to: unregistered });

    // #then
    const [saved] = await savedSends();
    expect({
      outcomes: [tag(first), tag(second)],
      status: saved?.status,
      ranIn: saved?.txHash === saved?.relayTxHashes[0],
      left: chain.state.usdcBalanceOf(companyAccount),
      ...observed(),
    }).toEqual({
      outcomes: ["SendRefused", "SendRefused"],
      status: "failed",
      ranIn: true,
      left: OPENING_BALANCE,
      signings: 0,
      broadcasts: 0,
    });
  });

  it.each([
    ["a recipient that isn't a NEAR account ID", { to: "Not.An.Account" }],
    [
      "a Base address in its checksum case",
      { to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    ],
    ["a zero amount", { amount: 0n }],
    ["a negative amount", { amount: -1n }],
  ])("refuses %s before saving anything", async (_name, overrides) => {
    // #given
    const observed = watching();

    // #when
    const exit = await send(overrides);

    // #then
    expect({
      outcome: tag(exit),
      sends: (await savedSends()).length,
      ...observed(),
    }).toEqual({
      outcome: "SendRefused",
      sends: 0,
      signings: 0,
      broadcasts: 0,
    });
  });

  it("refuses a key that already names a different transfer", async () => {
    // #given
    await send();
    const observed = watching();

    // #when
    const exit = await send({ amount: AMOUNT + 1n });

    // #then
    expect({ outcome: tag(exit), paid: paid(), ...observed() }).toEqual({
      outcome: "SendRefused",
      paid: AMOUNT,
      signings: 0,
      broadcasts: 0,
    });
  });

  it("refuses a company whose wallet was made on Base before the move", async () => {
    // #given
    const legacy = await createCompany(db);
    await createActiveWallet(db, legacy);
    const observed = watching();

    // #when
    const exit = await send({ organizationId: legacy.organizationId });

    // #then
    expect({ outcome: tag(exit), ...observed() }).toEqual({
      outcome: "SendRefused",
      signings: 0,
      broadcasts: 0,
    });
  });

  it("refuses a company with no wallet", async () => {
    // #given
    const bare = await createCompany(db);

    // #when
    const exit = await send({ organizationId: bare.organizationId });

    // #then
    expect(tag(exit)).toBe("SendRefused");
  });
});

describe("one send in flight per company wallet", () => {
  it("makes a second payout wait while the first is in flight, signing nothing for it", async () => {
    // #given
    chain.state.nextBroadcasts("drop");
    await send({ sendKey: "payout-1" });
    const observed = watching();

    // #when
    const second = await send({ sendKey: "payout-2" });

    // #then
    expect({
      outcome: tag(second),
      sends: (await savedSends()).length,
      ...observed(),
    }).toEqual({
      outcome: "CompanyWalletBusy",
      sends: 1,
      signings: 0,
      broadcasts: 0,
    });
  });

  it("lets the second payout through once the chain settles the first", async () => {
    // #given the first send's outcome arrives after its caller gave up
    chain.state.nextBroadcasts("withhold");
    await send({ sendKey: "payout-1" });
    chain.state.release();

    // #when
    const second = await send({ sendKey: "payout-2" });

    // #then
    const saved = await savedSends();
    expect({
      outcome: tag(second),
      statuses: saved.map(({ status }) => status),
      paid: paid(),
    }).toEqual({
      outcome: "sent",
      statuses: ["executed", "executed"],
      paid: AMOUNT * 2n,
    });
  });

  it("gives payouts sent one after another rising nonces", async () => {
    // #when
    await send({ sendKey: "payout-1" });
    await send({ sendKey: "payout-2" });
    await send({ sendKey: "payout-3" });

    // #then
    const nonces = (await savedSends()).map(({ nonce }) => nonce);
    expect({
      rising: nonces.every(
        (nonce, index) => index === 0 || nonce > (nonces[index - 1] ?? 0n),
      ),
      count: nonces.length,
      paid: paid(),
    }).toEqual({ rising: true, count: 3, paid: AMOUNT * 3n });
  });

  it("doesn't let one company's send in flight hold another company's wallet", async () => {
    // #given
    const other = await createCompany(db);
    const otherWallet = privy.state.addNearWallet(other.organizationId);
    chain.state.fundWithUsdc(otherWallet.accountId, OPENING_BALANCE);
    await createActiveNearWallet(db, other, otherWallet, CAP);
    chain.state.nextBroadcasts("drop");
    await send();

    // #when
    const exit = await send({ organizationId: other.organizationId });

    // #then
    expect(tag(exit)).toBe("sent");
  });
});

describe("sendUsdcFromCompanyWalletWithCall", () => {
  const deposit = (sendKey = `hop-${randomUUID()}`) =>
    runtime.runPromiseExit(
      sendUsdcFromCompanyWalletWithCall({
        organizationId: company.organizationId,
        sendKey,
        to: payee,
        amount: AMOUNT,
        msg: "quote-1",
      }),
    );

  it("counts as sent when the receiver keeps all of it", async () => {
    // #when
    const exit = await deposit();

    // #then
    const [saved] = await savedSends();
    expect({
      sent: Exit.isSuccess(exit),
      kind: saved?.kind,
      msg: saved?.msg,
      paid: paid(),
    }).toEqual({
      sent: true,
      kind: "transfer_call",
      msg: "quote-1",
      paid: AMOUNT,
    });
  });

  it("counts as failed when the receiver returns all of it", async () => {
    // #given
    chain.state.transferCallReceiverKeeps = false;

    // #when
    const exit = await deposit();

    // #then
    const [saved] = await savedSends();
    expect({
      sent: Exit.isSuccess(exit),
      status: saved?.status,
      left: chain.state.usdcBalanceOf(companyAccount),
    }).toEqual({ sent: false, status: "failed", left: OPENING_BALANCE });
  });

  it("is capped like a plain transfer", async () => {
    // #given
    const observed = watching();

    // #when
    const exit = await runtime.runPromiseExit(
      sendUsdcFromCompanyWalletWithCall({
        organizationId: company.organizationId,
        sendKey: "hop-over-cap",
        to: payee,
        amount: CAP + 1n,
        msg: "quote-1",
      }),
    );

    // #then
    expect({ sent: Exit.isSuccess(exit), ...observed() }).toEqual({
      sent: false,
      signings: 0,
      broadcasts: 0,
    });
  });
});

describe("delegateVerdict", () => {
  const sender = randomNearAccount();
  const receiver = "payee.near";
  const transfer = {
    kind: "transfer" as const,
    senderAccountId: sender,
    receiverAccountId: receiver,
    usdcAmount: 5_000_000n,
    tokenId: null,
  };
  const moved = (
    overrides: { to?: string; amount?: bigint; from?: string } = {},
  ) =>
    ftTransferLog([
      {
        from: overrides.from ?? sender,
        to: overrides.to ?? receiver,
        amount: overrides.amount ?? 5_000_000n,
      },
    ]);
  const relayed = (
    usdcLogs: readonly string[],
    options: { succeeded?: boolean; delegateRan?: boolean; usdc?: string } = {},
  ) =>
    nearOutcome(
      [
        { executorId: sender, succeeded: options.delegateRan ?? true },
        {
          executorId: options.usdc ?? TEST_USDC_CONTRACT,
          logs: usdcLogs,
          succeeded: options.succeeded ?? true,
        },
      ],
      { receiverId: sender, succeeded: options.succeeded ?? true },
    );
  const verdict = (outcome: ReturnType<typeof relayed>) =>
    delegateVerdict(outcome, transfer, TEST_NEAR_CHAIN);

  it("is executed when the USDC contract logged exactly the signed transfer", () => {
    expect(verdict(relayed([moved()]))).toBe("executed");
  });

  it("is failed when the delegate action ran and the USDC call failed", () => {
    expect(verdict(relayed([moved()], { succeeded: false }))).toBe("failed");
  });

  it("is not run when the chain rejected the delegate action itself", () => {
    expect(verdict(relayed([], { delegateRan: false, succeeded: false }))).toBe(
      "not_run",
    );
  });

  it.each([
    ["a different amount moved", relayed([moved({ amount: 4_999_999n })])],
    ["it went to a different account", relayed([moved({ to: "thief.near" })])],
    ["a second transfer moved with it", relayed([moved(), moved()])],
    ["it succeeded with no transfer logged", relayed([])],
    [
      "the transfer was logged by another contract",
      relayed([moved()], { usdc: "evil.near" }),
    ],
    [
      "the transaction wasn't sent to the company wallet",
      { ...relayed([moved()]), receiverId: "someone-else.near" },
    ],
  ])("is unclear when %s", (_name, outcome) => {
    expect(verdict(outcome)).toBe("unclear");
  });
});

describe("sendIntentsTokenFromCompanyWallet", () => {
  const TOKEN = ONE_CLICK_FUND_IN_USDC_ASSET_IDS.base;
  const OTHER_TOKEN = ONE_CLICK_FUND_IN_USDC_ASSET_IDS.solana;

  beforeEach(() => {
    chain.state.fundIntents(companyAccount, TOKEN, OPENING_BALANCE);
  });

  const sendToken = (
    overrides: Partial<
      Parameters<typeof sendIntentsTokenFromCompanyWallet>[0]
    > = {},
  ) =>
    runtime.runPromiseExit(
      sendIntentsTokenFromCompanyWallet({
        organizationId: company.organizationId,
        sendKey: "refund-1",
        to: payee,
        amount: AMOUNT,
        tokenId: TOKEN,
        ...overrides,
      }),
    );

  it("moves the token inside NEAR Intents and saves the send with its token", async () => {
    // #when
    const exit = await sendToken();

    // #then
    const [saved] = await savedSends();
    expect({
      sent: Exit.isSuccess(exit),
      paid: chain.state.intentsBalanceOf(payee, TOKEN),
      left: chain.state.intentsBalanceOf(companyAccount, TOKEN),
      usdcMoved: paid(),
      saved: {
        kind: saved?.kind,
        status: saved?.status,
        tokenId: saved?.tokenId,
        msg: saved?.msg,
        usdcAmount: saved?.usdcAmount,
      },
    }).toEqual({
      sent: true,
      paid: AMOUNT,
      left: OPENING_BALANCE - AMOUNT,
      usdcMoved: 0n,
      saved: {
        kind: "intents_transfer",
        status: "executed",
        tokenId: TOKEN,
        msg: null,
        usdcAmount: AMOUNT,
      },
    });
  });

  it("signs a delegate action to the Intents contract, relayed by the gas relayer", async () => {
    // #when
    await sendToken();

    // #then
    const outcome = chain.state.outcomes.get(
      chain.state.broadcasts.at(-1) ?? "",
    );
    expect({
      signer: outcome?.signerId,
      receiver: outcome?.receiverId,
      ranOn: outcome?.receipts.map((receipt) => receipt.executorId),
    }).toEqual({
      signer: relayer.accountId,
      receiver: companyAccount,
      ranOn: [companyAccount, TEST_INTENTS_CONTRACT],
    });
  });

  it("returns the same receipt for the same key without signing again", async () => {
    // #given
    const first = await sendToken();
    const observed = watching();

    // #when
    const second = await sendToken();

    // #then
    expect({
      same:
        Exit.isSuccess(first) &&
        Exit.isSuccess(second) &&
        first.value.sendId === second.value.sendId,
      paid: chain.state.intentsBalanceOf(payee, TOKEN),
      ...observed(),
    }).toEqual({ same: true, paid: AMOUNT, signings: 0, broadcasts: 0 });
  });

  it("fails for good when the contract moved nothing", async () => {
    // #given
    chain.state.fundIntents(companyAccount, TOKEN, -OPENING_BALANCE);

    // #when
    const exit = await sendToken();

    // #then
    const [saved] = await savedSends();
    expect({ outcome: tag(exit), status: saved?.status }).toEqual({
      outcome: "SendRefused",
      status: "failed",
    });
  });

  it.each([
    ["a made-up token", "nep141:made-up.omft.near"],
    ["an empty token", ""],
    ["the NEAR USDC contract", TEST_USDC_CONTRACT],
  ])(
    "refuses %s before reserving or signing anything",
    async (_name, tokenId) => {
      // #given
      const observed = watching();

      // #when
      const exit = await sendToken({ tokenId });

      // #then
      expect({
        outcome: tag(exit),
        saved: await savedSends(),
        ...observed(),
      }).toMatchObject({
        outcome: "SendRefused",
        saved: [],
        signings: 0,
        broadcasts: 0,
      });
    },
  );

  it("refuses a key that already names the same transfer of a different token", async () => {
    // #given
    await sendToken();
    const observed = watching();

    // #when
    const exit = await sendToken({ tokenId: OTHER_TOKEN });

    // #then
    expect({
      outcome: tag(exit),
      paid: chain.state.intentsBalanceOf(payee, TOKEN),
      other: chain.state.intentsBalanceOf(payee, OTHER_TOKEN),
      ...observed(),
    }).toEqual({
      outcome: "SendRefused",
      paid: AMOUNT,
      other: 0n,
      signings: 0,
      broadcasts: 0,
    });
  });

  it("refuses a key already used for a USDC send of the same amount", async () => {
    // #given
    await send({ sendKey: "shared-key" });

    // #when
    const exit = await sendToken({ sendKey: "shared-key" });

    // #then
    expect(tag(exit)).toBe("SendRefused");
  });

  it("is capped like a USDC send", async () => {
    // #given
    const observed = watching();

    // #when
    const exit = await sendToken({ amount: CAP + 1n });

    // #then
    expect({ sent: Exit.isSuccess(exit), ...observed() }).toEqual({
      sent: false,
      signings: 0,
      broadcasts: 0,
    });
  });
});

describe("delegateVerdict for an Intents transfer", () => {
  const TOKEN = ONE_CLICK_FUND_IN_USDC_ASSET_IDS.base;
  const sender = randomNearAccount();
  const receiver = "deposit.near";
  const intentsSend = {
    kind: "intents_transfer" as const,
    senderAccountId: sender,
    receiverAccountId: receiver,
    usdcAmount: 5_000_000n,
    tokenId: TOKEN,
  };
  const moved = (
    overrides: {
      to?: string;
      from?: string;
      tokenId?: string;
      amount?: bigint;
    } = {},
  ) =>
    mtTransferLog([
      {
        from: overrides.from ?? sender,
        to: overrides.to ?? receiver,
        tokenIds: [overrides.tokenId ?? TOKEN],
        amounts: [overrides.amount ?? 5_000_000n],
      },
    ]);
  const relayed = (
    intentsLogs: readonly string[],
    options: {
      succeeded?: boolean;
      delegateRan?: boolean;
      intents?: string;
      usdcLogs?: readonly string[];
    } = {},
  ) =>
    nearOutcome(
      [
        { executorId: sender, succeeded: options.delegateRan ?? true },
        {
          executorId: options.intents ?? TEST_INTENTS_CONTRACT,
          logs: intentsLogs,
          succeeded: options.succeeded ?? true,
        },
        ...(options.usdcLogs
          ? [{ executorId: TEST_USDC_CONTRACT, logs: options.usdcLogs }]
          : []),
      ],
      { receiverId: sender, succeeded: options.succeeded ?? true },
    );
  const verdict = (outcome: ReturnType<typeof relayed>) =>
    delegateVerdict(outcome, intentsSend, TEST_NEAR_CHAIN);

  it("is executed when the Intents contract logged exactly the signed transfer", () => {
    expect(verdict(relayed([moved()]))).toBe("executed");
  });

  it("is failed when the delegate action ran and the Intents call failed", () => {
    expect(verdict(relayed([], { succeeded: false }))).toBe("failed");
  });

  it("is not run when the chain rejected the delegate action itself", () => {
    expect(verdict(relayed([], { delegateRan: false, succeeded: false }))).toBe(
      "not_run",
    );
  });

  it.each([
    ["a different amount moved", relayed([moved({ amount: 4_999_999n })])],
    ["it went to a different account", relayed([moved({ to: "thief.near" })])],
    [
      "it came from a different account",
      relayed([moved({ from: "other.near" })]),
    ],
    [
      "a different token moved",
      relayed([moved({ tokenId: ONE_CLICK_FUND_IN_USDC_ASSET_IDS.solana })]),
    ],
    ["a second transfer moved with it", relayed([moved(), moved()])],
    ["it succeeded with no transfer logged", relayed([])],
    [
      "the transfer was logged by another contract",
      relayed([moved()], { intents: "evil.near" }),
    ],
    [
      "USDC moved as well",
      relayed([moved()], {
        usdcLogs: [
          ftTransferLog([{ from: sender, to: "thief.near", amount: 1n }]),
        ],
      }),
    ],
    [
      "it failed after USDC moved",
      relayed([], {
        succeeded: false,
        usdcLogs: [ftTransferLog([{ from: sender, to: receiver, amount: 1n }])],
      }),
    ],
    [
      "the transaction wasn't sent to the company wallet",
      { ...relayed([moved()]), receiverId: "someone-else.near" },
    ],
  ])("is unclear when %s", (_name, outcome) => {
    expect(verdict(outcome)).toBe("unclear");
  });
});
