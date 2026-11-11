import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ResolveOutcome } from "@expendi-business/shared";
import {
  resolveConfirmedSchema,
  resolvePreparedSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { UsdcTransfer } from "../../services/chain/base.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmOnchainPayouts,
  SEND_UNCLEAR_AFTER_MS,
} from "../../services/payout/onchain.js";
import { SEND_RELEASE_MARGIN_BLOCKS } from "../../services/staff/near-send-evidence.js";
import { gatherChainAndPaycrest } from "../../services/staff/payout-evidence.js";
import { randomTxHash } from "../helpers/chain.js";
import { makeFakeBaseRpc, makeFakePaycrest } from "../helpers/fakes.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
  nearUsdcBill,
  registeredNearAccount,
  savedSends,
} from "../helpers/near-usdc-payouts.js";
import {
  allowlistAddress,
  claimRequest,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Serial: these leave sends open on purpose and run the confirmation job,
// which follows every company's USDC payouts.

const AMOUNT = 25n * USDC;
const OPENING_BALANCE = 100n * USDC;
const REASON = "Checked the send's transactions on Nearblocks by hand.";

const fakes = makeNearUsdcFakes();
const { chain } = fakes;
const paycrest = makeFakePaycrest();
const baseRpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let viewer: TestStaff;
let paying: NearUsdcPayingCompany;
let payee: string;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { ...fakes.layers, paycrest: paycrest.layer, baseRpc: baseRpc.layer },
    fakes.env,
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [admin, viewer] = await Promise.all([
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paying = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    OPENING_BALANCE,
  );
  payee = registeredNearAccount(fakes);
  await allowlistAddress(runtime, paying, payee, "Supplier", "near");
});

// Fixtures

const inCompany = <T>(work: Parameters<typeof runInScope<T>>[2]): Promise<T> =>
  runInScope(db, { organizationId: paying.company.organizationId }, work);

const runJob = () => runtime.runPromise(confirmOnchainPayouts(500));
const reload = (payout: Payout) => readPayout(db, paying.company, payout.id);
const sends = () => savedSends(db, paying.company);

async function pay(): Promise<Payout> {
  const [payout] = await payClaims(runtime, db, paying, [nearUsdcBill(payee)]);
  if (!payout) throw new Error("nothing was prepared");
  return payout;
}

/**
 * A NEAR payout whose send was signed and relayed, and whose outcome the
 * job couldn't read for so long that it put the payout under review. The
 * send is still open.
 */
async function underReview(
  whatTheChainDid: "ran_unseen" | "never_included",
): Promise<Payout> {
  chain.state.nextBroadcasts(
    whatTheChainDid === "ran_unseen" ? "withhold" : "drop",
  );
  const payout = await pay();
  await inCompany((tx) =>
    tx
      .update(companyWalletSends)
      .set({ createdAt: new Date(Date.now() - SEND_UNCLEAR_AFTER_MS - 1000) })
      .where(eq(companyWalletSends.sendKey, `payout-${payout.id}`)),
  );
  await runJob();
  const reviewed = await reload(payout);
  if (reviewed.status !== "needs_review") {
    throw new Error(`expected needs_review, got ${reviewed.status}`);
  }
  return reviewed;
}

/**
 * The company wallet's key was used by something that isn't in the saved
 * sends, so its nonce has passed the open send's: the chain can no longer
 * say from the nonce that the send never ran, and nothing settles it.
 */
async function nonceUsedElsewhere(): Promise<void> {
  const [open] = await sends();
  if (!open) throw new Error("no send");
  chain.state.accounts.set(paying.wallet.address, open.nonce);
}

const debits = (payout: Payout) =>
  inCompany((tx) =>
    tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.payoutId, payout.id)),
  );

async function auditEntries(payoutId: string, action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    after: Record<string, unknown>;
  }>(
    `SELECT actor_type, actor_id, after
     FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 AND action = $2`,
    [payoutId, action],
  );
  return rows;
}

// HTTP

async function post(
  path: string,
  staff: TestStaff,
  body: unknown = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

interface SendEvidence {
  readonly id: string;
  readonly status: string;
  readonly senderAccountId: string;
  readonly receiverAccountId: string;
  readonly usdcAmount: string;
  readonly txHash: string | null;
  readonly transactions: readonly {
    readonly txHash: string;
    readonly final: boolean;
    readonly succeeded: boolean | null;
    readonly sendRan: boolean | null;
    readonly usdcTransfers: readonly {
      readonly from: string;
      readonly to: string;
      readonly usdcAmount: string;
    }[];
  }[];
}

interface Evidence {
  readonly fundingStarted: boolean;
  readonly depositTransfers: readonly {
    readonly chain: string;
    readonly txHash: string;
    readonly usdcAmount: string;
  }[];
  readonly companyWalletSends: readonly SendEvidence[];
}

async function dataOf<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T };
  return body.data;
}

async function messageOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

const evidence = (payout: Payout, staff = viewer) =>
  app.request(`/internal/payouts/${payout.id}/evidence`, {
    headers: bearer(staff.privyUserId),
  });

const prepare = (payout: Payout, outcome: ResolveOutcome, staff = admin) =>
  post(`/internal/payouts/${payout.id}/resolve/prepare`, staff, {
    outcome,
    reason: REASON,
  });

async function resolve(payout: Payout, outcome: ResolveOutcome) {
  const prepared = await prepare(payout, outcome);
  if (prepared.status !== 201) {
    throw new Error(`prepare refused: ${await messageOf(prepared)}`);
  }
  const { token, consequences } = resolvePreparedSchema.parse(
    await dataOf(prepared),
  );
  const confirmed = await post(
    `/internal/payouts/${payout.id}/resolve/confirm`,
    admin,
    { token },
  );
  return { confirmed, consequences };
}

describe("GET /internal/payouts/:id/evidence for a NEAR payout", () => {
  it("shows the saved send, its relayer transaction, the chain's outcome and the USDC it moved", async () => {
    // #given
    const payout = await pay();
    const relayed = chain.state.broadcasts.at(-1);

    // #when
    const response = await evidence(payout);

    // #then
    const shown = await dataOf<Evidence>(response);
    expect({ status: response.status, ...shown }).toMatchObject({
      status: 200,
      fundingStarted: true,
      depositTransfers: [
        { chain: "near", txHash: relayed, usdcAmount: AMOUNT.toString() },
      ],
      companyWalletSends: [
        {
          status: "executed",
          senderAccountId: paying.wallet.address,
          receiverAccountId: payee,
          usdcAmount: AMOUNT.toString(),
          txHash: relayed,
          transactions: [
            {
              txHash: relayed,
              final: true,
              succeeded: true,
              sendRan: true,
              usdcTransfers: [
                {
                  from: paying.wallet.address,
                  to: payee,
                  usdcAmount: AMOUNT.toString(),
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("shows a relayer transaction the chain hasn't finished as not final, with nothing moved", async () => {
    // #given
    const payout = await underReview("never_included");

    // #when
    const shown = await dataOf<Evidence>(await evidence(payout));

    // #then
    expect(shown).toMatchObject({
      depositTransfers: [],
      companyWalletSends: [
        {
          status: "signed",
          txHash: null,
          transactions: [{ final: false, sendRan: null, usdcTransfers: [] }],
        },
      ],
    });
  });

  it("keeps every hash exactly as the chain gave it, capitals included", async () => {
    // #given
    const payout = await pay();
    const relayed = chain.state.broadcasts.at(-1) ?? "";

    // #when
    const shown = await dataOf<Evidence>(await evidence(payout));

    // #then
    expect({
      mixedCase: relayed !== relayed.toLowerCase(),
      transfer: shown.depositTransfers[0]?.txHash,
      send: shown.companyWalletSends[0]?.txHash,
      relayed: shown.companyWalletSends[0]?.transactions[0]?.txHash,
    }).toEqual({
      mixedCase: true,
      transfer: relayed,
      send: relayed,
      relayed,
    });
  });

  it("answers 503, changing nothing, when NEAR can't be read", async () => {
    // #given
    const payout = await pay();
    chain.state.failNext("finalBlock");

    // #when
    const response = await evidence(payout);

    // #then
    expect({
      status: response.status,
      payout: (await reload(payout)).status,
    }).toEqual({ status: 503, payout: "paying" });
  });

  it("refuses someone who isn't staff", async () => {
    // #given
    const payout = await pay();

    // #when
    const response = await app.request(
      `/internal/payouts/${payout.id}/evidence`,
      { headers: bearer(paying.company.admin.privyUserId) },
    );

    // #then
    expect(response.status).toBe(403);
  });
});

describe("resolving a NEAR payout as paid", () => {
  it("records the one missing debit and settles the open send as run, once the chain shows the transfer", async () => {
    // #given the send ran, but its outcome was hidden until after the review
    const payout = await underReview("ran_unseen");
    chain.state.release();
    const relayed = chain.state.broadcasts.at(-1);

    // #when
    const { confirmed } = await resolve(payout, "paid");

    // #then
    const result = resolveConfirmedSchema.parse(await dataOf(confirmed));
    const [send] = await sends();
    const paid = await reload(payout);
    expect({
      status: confirmed.status,
      payout: result.status,
      txHash: paid.txHash,
      reference: paid.providerReference,
      debits: (await debits(payout)).map((row) => ({
        chain: row.chain,
        usdcAmount: row.usdcAmount,
        txHash: row.txHash,
      })),
      ledger: await ledgerBalance(db, paying.company),
      send: { status: send?.status, txHash: send?.txHash },
    }).toEqual({
      status: 200,
      payout: "paid",
      txHash: relayed,
      reference: relayed,
      debits: [{ chain: "near", usdcAmount: -AMOUNT, txHash: relayed }],
      ledger: OPENING_BALANCE - AMOUNT,
      send: { status: "executed", txHash: relayed },
    });
  });

  it("refuses while the chain shows no transfer to the payee", async () => {
    // #given
    const payout = await underReview("never_included");

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect({
      status: response.status,
      payout: (await reload(payout)).status,
      send: (await sends())[0]?.status,
    }).toEqual({ status: 409, payout: "needs_review", send: "signed" });
  });

  it("refuses a transfer the chain shows for another amount than the send signed", async () => {
    // #given
    const payout = await underReview("ran_unseen");
    chain.state.release();
    const relayed = chain.state.broadcasts.at(-1) ?? "";
    const outcome = chain.state.outcomes.get(relayed);
    if (!outcome) throw new Error("no outcome");
    chain.state.outcomes.set(relayed, {
      ...outcome,
      receipts: outcome.receipts.map((receipt) => ({
        ...receipt,
        logs: receipt.logs.map((log) =>
          log.replace(`"${AMOUNT}"`, `"${AMOUNT - 1n}"`),
        ),
      })),
    });

    // #when
    const responses = await Promise.all([
      prepare(payout, "paid"),
      prepare(payout, "failed"),
    ]);

    // #then
    expect({
      statuses: responses.map((response) => response.status),
      explains: (await messageOf(responses[0])).includes(
        "needs a correction by hand",
      ),
      debits: (await debits(payout)).length,
    }).toEqual({ statuses: [409, 409], explains: true, debits: 0 });
  });

  it("leaves a debit the payout already has alone", async () => {
    // #given a payout that was sent and debited, then put under review
    const payout = await pay();
    await updatePayout(db, paying.company, payout.id, {
      status: "needs_review",
    });

    // #when
    const { confirmed } = await resolve(await reload(payout), "paid");

    // #then
    expect({
      status: confirmed.status,
      payout: (await reload(payout)).status,
      debits: (await debits(payout)).length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: 200,
      payout: "paid",
      debits: 1,
      ledger: OPENING_BALANCE - AMOUNT,
    });
  });
});

describe("resolving a NEAR payout as failed", () => {
  it("refuses while the open send could still run", async () => {
    // #given a send that hasn't reached a block and hasn't expired
    const payout = await underReview("never_included");

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect({
      status: response.status,
      explains: (await messageOf(response)).includes("could run until block"),
      send: (await sends())[0]?.status,
    }).toEqual({ status: 409, explains: true, send: "signed" });
  });

  it("refuses just past the expiry, until the chain is well beyond it", async () => {
    // #given
    const payout = await underReview("never_included");
    await nonceUsedElsewhere();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS - 1n);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
  });

  it("refuses when the chain shows the USDC went to the payee", async () => {
    // #given
    const payout = await underReview("ran_unseen");
    chain.state.release();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect({
      status: response.status,
      payout: (await reload(payout)).status,
    }).toEqual({ status: 409, payout: "needs_review" });
  });

  it("closes the payout and releases the send nothing could settle, with no debit", async () => {
    // #given a send that can no longer run and that the chain can't settle
    const payout = await underReview("never_included");
    await nonceUsedElsewhere();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS);

    // #when
    const { confirmed, consequences } = await resolve(payout, "failed");

    // #then
    const [send] = await sends();
    expect({
      status: confirmed.status,
      payout: (await reload(payout)).status,
      send: send?.status,
      note: send?.failure,
      debits: (await debits(payout)).length,
      ledger: await ledgerBalance(db, paying.company),
      paidToPayee: chain.state.usdcBalanceOf(payee),
      saysSo: consequences.some((line) =>
        line.includes("open send is closed as never having moved anything"),
      ),
    }).toEqual({
      status: 200,
      payout: "failed",
      send: "expired",
      note: `Closed by Expendi staff: expired at block ${send?.maxBlockHeight} without running`,
      debits: 0,
      ledger: OPENING_BALANCE,
      paidToPayee: 0n,
      saysSo: true,
    });
  });

  it("keeps the wallet's other payouts waiting, unfailed, until the stuck send is released, then they are paid", async () => {
    // #given a stuck send, and a second payout from the same wallet
    const stuck = await underReview("never_included");
    await nonceUsedElsewhere();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS);
    const waiting = await pay();
    await runJob();
    const whileStuck = (await reload(waiting)).status;

    // #when
    await resolve(stuck, "failed");
    await runJob();

    // #then
    expect({
      whileStuck,
      after: (await reload(waiting)).status,
      paidToPayee: chain.state.usdcBalanceOf(payee),
    }).toEqual({ whileStuck: "funding", after: "paid", paidToPayee: AMOUNT });
  });

  it("audits the resolution as the staff member, with the send it closed", async () => {
    // #given
    const payout = await underReview("never_included");
    await nonceUsedElsewhere();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS);
    const [open] = await sends();

    // #when
    await resolve(payout, "failed");

    // #then
    const [entry] = await auditEntries(payout.id, "payout.resolved");
    expect(entry).toMatchObject({
      actor_type: "staff",
      actor_id: admin.staffUserId,
      after: {
        status: "failed",
        note: REASON,
        companyWalletSendsClosed: [{ sendId: open?.id, status: "expired" }],
      },
    });
  });

  it("needs the second confirmation: preparing alone changes nothing", async () => {
    // #given
    const payout = await underReview("never_included");
    await nonceUsedElsewhere();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect({
      status: response.status,
      payout: (await reload(payout)).status,
      send: (await sends())[0]?.status,
    }).toEqual({ status: 201, payout: "needs_review", send: "signed" });
  });

  it("refuses an ops viewer, changing nothing", async () => {
    // #given
    const payout = await underReview("never_included");
    await nonceUsedElsewhere();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS);

    // #when
    const response = await prepare(payout, "failed", viewer);

    // #then
    expect({
      status: response.status,
      send: (await sends())[0]?.status,
    }).toEqual({ status: 403, send: "signed" });
  });

  it("signs and relays nothing", async () => {
    // #given
    const payout = await underReview("never_included");
    await nonceUsedElsewhere();
    fakes.passExpiry(SEND_RELEASE_MARGIN_BLOCKS);
    const signings = fakes.privy.state.nearSigningRequestsFor(
      paying.privyWalletId,
    );
    const broadcasts = chain.state.broadcasts.length;

    // #when
    await resolve(payout, "failed");

    // #then
    expect({
      signings:
        fakes.privy.state.nearSigningRequestsFor(paying.privyWalletId) -
        signings,
      broadcasts: chain.state.broadcasts.length - broadcasts,
    }).toEqual({ signings: 0, broadcasts: 0 });
  });
});

describe("the chain evidence for a cash-out of a company on NEAR", () => {
  it("is read from the transit wallet on Base, not from the NEAR account", async () => {
    // #given a cash-out whose funding started, and a transfer from the
    // transit wallet to its deposit address
    const [claim] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!claim) throw new Error("no claim payout");
    const [wallet] = await inCompany((tx) =>
      tx.select().from(wallets).where(eq(wallets.id, paying.wallet.id)),
    );
    if (!wallet?.transitAddress) throw new Error("no transit wallet");
    const depositAddress = `0x${"ab".repeat(20)}`;
    const transfer: UsdcTransfer = {
      from: wallet.transitAddress.toLowerCase(),
      to: depositAddress,
      amount: 11n * USDC,
      logIndex: 3,
      blockNumber: baseRpc.state.latestBlock - 10n,
      txHash: randomTxHash(),
    };
    baseRpc.state.transfers.push(transfer);

    // #when
    const gathered = await runtime.runPromise(
      gatherChainAndPaycrest(
        {
          ...claim,
          providerOrderId: null,
          fundingStartedAt: new Date(),
          depositAddress,
        },
        wallet,
      ),
    );

    // #then
    expect({
      chain: gathered.chain,
      near: gathered.near,
      transfers: gathered.depositTransfers,
    }).toEqual({ chain: "base", near: null, transfers: [transfer] });
  });
});
