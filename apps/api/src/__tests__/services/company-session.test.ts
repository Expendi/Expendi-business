import { eq } from "drizzle-orm";
import { Effect, Exit, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { FundedCompany } from "../helpers/money-in.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { DatabaseService } from "../../db/client.js";
import { wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  sessionForQuote,
  touchesConfidentialAccount,
} from "../../services/intents/company-session.js";
import { ConfidentialAccounts } from "../../services/intents/confidential-account.js";
import { OneClick } from "../../services/intents/one-click.js";
import { advanceCompanyQuote } from "../../services/intents/quote-deposit.js";
import { settleFromOneClick } from "../../services/intents/quote-settle.js";
import { refreshQuoteStatus } from "../../services/intents/quote-status.js";
import { SendRefused } from "../../services/wallet/privy-wallets.js";
import { saveQuote, saveTreasuryMove } from "../helpers/money-in.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const fakes = makeNearUsdcFakes();
const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let paying: NearUsdcPayingCompany;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { ...fakes.layers, oneClick: oneClick.layer },
    fakes.env,
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  fakes.chain.state.fundWithUsdc(fakes.relayer.accountId, 1_000n * USDC);
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  paying = await createNearUsdcPayingCompany(runtime, db, fakes);
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({ transitAddress: wallets.transitAddress })
        .from(wallets)
        .where(eq(wallets.id, paying.wallet.id)),
  );
  if (!row?.transitAddress) throw new Error("wallet has no transit address");
  funded = {
    company: paying.company,
    walletId: paying.wallet.id,
    accountId: paying.wallet.address,
    transitAddress: row.transitAddress,
  };
});

const organizationId = () => paying.company.organizationId;

const none = {
  depositType: "ORIGIN_CHAIN",
  recipientType: "DESTINATION_CHAIN",
  refundType: "ORIGIN_CHAIN",
} as const;

const callsFor = (depositAddress: string, call: string) =>
  oneClick.state.calls.filter(
    (entry) => entry.depositAddress === depositAddress && entry.call === call,
  );

/**
 * On the real chain the USDC contract registers a deposit address that
 * doesn't exist yet; the fake chain wants the account to exist, as receiving
 * NEAR makes it.
 */
async function savedQuote(
  purpose: Parameters<typeof saveQuote>[3],
  options?: Parameters<typeof saveQuote>[4],
): Promise<IntentQuote> {
  const quote = await saveQuote(runtime, db, funded, purpose, options);
  fakes.chain.state.createAccount(quote.depositAddress);
  return quote;
}

const go = () => Effect.succeed({ kind: "go" as const });

describe("touchesConfidentialAccount", () => {
  it.each([
    ["no side", none, false],
    [
      "a confidential recipient",
      { ...none, recipientType: "CONFIDENTIAL_INTENTS" },
      true,
    ],
    [
      "a confidential deposit",
      { ...none, depositType: "CONFIDENTIAL_INTENTS" },
      true,
    ],
    [
      "a confidential refund",
      { ...none, refundType: "CONFIDENTIAL_INTENTS" },
      true,
    ],
    [
      "the public NEAR Intents account on both sides",
      { ...none, depositType: "INTENTS", refundType: "INTENTS" },
      false,
    ],
  ] as const)("is decided by %s", (_name, sides, expected) => {
    expect(touchesConfidentialAccount(sides)).toBe(expected);
  });
});

describe("sessionForQuote", () => {
  it("gives a quote that touches no confidential account no session, and signs in to nothing", async () => {
    // #given
    const signedBefore = fakes.privy.state.nearSigningRequestsFor(
      paying.privyWalletId,
    );

    // #when
    const session = await runtime.runPromise(
      sessionForQuote({ organizationId: organizationId(), ...none }),
    );

    // #then
    expect({
      session,
      signIns: oneClick.state.signIns.filter(
        (signer) => signer === paying.wallet.address,
      ),
      signings:
        fakes.privy.state.nearSigningRequestsFor(paying.privyWalletId) -
        signedBefore,
    }).toEqual({ session: undefined, signIns: [], signings: 0 });
  });

  it.each([
    ["recipient", { recipientType: "CONFIDENTIAL_INTENTS" }],
    ["deposit", { depositType: "CONFIDENTIAL_INTENTS" }],
    ["refund", { refundType: "CONFIDENTIAL_INTENTS" }],
  ] as const)(
    "signs the company in for a quote with a confidential %s",
    async (_name, sides) => {
      // #given
      oneClick.state.fundConfidential(paying.wallet.address, 7n * USDC);

      // #when
      const session = await runtime.runPromise(
        sessionForQuote({
          organizationId: organizationId(),
          ...none,
          ...sides,
        }),
      );
      if (session === undefined) throw new Error("no session");
      const balances = await Effect.runPromise(
        oneClick.service.balances(session),
      );

      // #then the session is the company's own
      expect(balances.map((balance) => balance.available)).toEqual([7n * USDC]);
    },
  );

  it("fails with the sign-in's error when the company wallet refuses to sign", async () => {
    // #given
    fakes.privy.state.nextNearSignings("refused");

    // #when
    const exit = await runtime.runPromiseExit(
      sessionForQuote({
        organizationId: organizationId(),
        ...none,
        recipientType: "CONFIDENTIAL_INTENTS",
      }),
    );

    // #then
    expect(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? exit.cause.error._tag
        : exit,
    ).toBe("SendRefused");
  });

  it("is a defect for a quote whose company has no wallet", async () => {
    // #given a company that has none
    const { company } = await createNearUsdcPayingCompany(runtime, db, fakes);
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(wallets)
        .set({ status: "creating" })
        .where(eq(wallets.organizationId, company.organizationId)),
    );

    // #when
    const exit = await runtime.runPromiseExit(
      sessionForQuote({
        organizationId: company.organizationId,
        ...none,
        recipientType: "CONFIDENTIAL_INTENTS",
      }),
    );

    // #then
    expect(Exit.isFailure(exit) && exit.cause._tag).toBe("Die");
  });
});

describe("refreshQuoteStatus and settleFromOneClick", () => {
  it("send no session unless given one", async () => {
    // #given a quote that touches no confidential account
    const hop = await saveQuote(runtime, db, funded, "base_hop");

    // #when
    await runtime.runPromise(refreshQuoteStatus(hop));
    await runtime.runPromise(settleFromOneClick(hop));

    // #then
    expect(
      callsFor(hop.depositAddress, "status").map((entry) => entry.session),
    ).toEqual([undefined, undefined]);
  });

  it("pass a given session to 1Click's status", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop");
    const session = Redacted.make("a-session");

    // #when
    await runtime.runPromise(refreshQuoteStatus(hop, session));
    await runtime.runPromise(settleFromOneClick(hop, session));

    // #then
    expect(
      callsFor(hop.depositAddress, "status").map(
        (entry) => entry.session && Redacted.value(entry.session),
      ),
    ).toEqual(["a-session", "a-session"]);
  });

  it("hear nothing of a confidential quote without the company's session", async () => {
    // #given
    const moveIn = await saveQuote(runtime, db, funded, "move_in");

    // #when
    const exit = await runtime.runPromiseExit(refreshQuoteStatus(moveIn));

    // #then 1Click answers as if the quote did not exist
    expect(
      Exit.isFailure(exit) && exit.cause._tag === "Fail"
        ? exit.cause.error
        : exit,
    ).toMatchObject({ _tag: "OneClickRefused", httpStatus: 404 });
  });

  it("settle a confidential quote from what 1Click reports to the company's session", async () => {
    // #given a move-in being paid, which 1Click reports delivered
    const moveIn = await saveQuote(runtime, db, funded, "move_in");
    const depositing: IntentQuote = { ...moveIn, status: "depositing" };
    oneClick.state.setStatus(moveIn.depositAddress, { status: "SUCCESS" });
    const session = await runtime.runPromise(sessionForQuote(moveIn));

    // #when settling without, then with the session
    const without = await runtime.runPromise(settleFromOneClick(depositing));
    const settled = await runtime.runPromise(
      settleFromOneClick(depositing, session),
    );

    // #then
    expect({
      without: without.oneClickStatus,
      withSession: settled.oneClickStatus,
    }).toEqual({ without: null, withSession: "SUCCESS" });
  });
});

describe("advanceCompanyQuote", () => {
  it("tells 1Click about a move-in's deposit and reads its status with the session, and covers no fee", async () => {
    // #given
    const moveIn = await savedQuote("move_in");
    const session = await runtime.runPromise(sessionForQuote(moveIn));
    const relayerBefore = fakes.chain.state.usdcBalanceOf(
      fakes.relayer.accountId,
    );

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({ quote: moveIn, beforeDeposit: go, session }),
    );

    // #then the company wallet paid the deposit address, the relayer sent
    // nothing, and every call that can carry the session did
    expect({
      status: advanced.status,
      feeCover: advanced.feeCoverUsdc,
      relayerPaid:
        relayerBefore -
        fakes.chain.state.usdcBalanceOf(fakes.relayer.accountId),
      deposited: fakes.chain.state.usdcBalanceOf(moveIn.depositAddress),
      told: callsFor(moveIn.depositAddress, "submitDeposit").map(
        (entry) => entry.session !== undefined,
      ),
      asked: callsFor(moveIn.depositAddress, "status").every(
        (entry) => entry.session !== undefined,
      ),
    }).toEqual({
      status: "depositing",
      feeCover: null,
      relayerPaid: 0n,
      deposited: moveIn.amountIn,
      told: [true],
      asked: true,
    });
  });

  it("signs the company in itself when given no session for a quote that touches a confidential account", async () => {
    // #given
    const moveIn = await savedQuote("move_in");

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({ quote: moveIn, beforeDeposit: go }),
    );

    // #then
    expect({
      status: advanced.status,
      told: callsFor(moveIn.depositAddress, "submitDeposit").map(
        (entry) => entry.session !== undefined,
      ),
      asked: callsFor(moveIn.depositAddress, "status").map(
        (entry) => entry.session !== undefined,
      ),
    }).toEqual({ status: "depositing", told: [true], asked: [true] });
  });

  it("returns the quote unchanged, and sends nothing, when the company can't be signed in", async () => {
    // #given
    const moveIn = await savedQuote("move_in");
    const accounts = await runtime.runPromise(ConfidentialAccounts);
    const refused = Effect.fail(
      new SendRefused({ message: "no", status: 403, policyViolation: false }),
    );

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({ quote: moveIn, beforeDeposit: go }).pipe(
        Effect.provideService(ConfidentialAccounts, {
          ...accounts,
          session: () => refused,
        }),
      ),
    );

    // #then
    expect({
      status: advanced.status,
      deposited: fakes.chain.state.usdcBalanceOf(moveIn.depositAddress),
    }).toEqual({ status: "quoted", deposited: 0n });
  });

  it("sends exactly what it sent before when given no session", async () => {
    // #given
    const hop = await savedQuote("base_hop");

    // #when
    await runtime.runPromise(
      advanceCompanyQuote({ quote: hop, beforeDeposit: go }),
    );

    // #then
    expect(
      oneClick.state.calls
        .filter((entry) => entry.depositAddress === hop.depositAddress)
        .map((entry) => [entry.call, entry.session]),
    ).toEqual([
      ["submitDeposit", undefined],
      ["status", undefined],
    ]);
  });

  it("covers a Base hop's cost with the gas relayer", async () => {
    // #given
    const hop = await savedQuote("base_hop");

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({ quote: hop, beforeDeposit: go }),
    );

    // #then
    expect(advanced.feeCoverUsdc).toBe(hop.amountIn - hop.amountOut);
  });

  it("covers a USDC payout's cost with the gas relayer", async () => {
    // #given
    const payout = await savedQuote("usdc_payout");

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({ quote: payout, beforeDeposit: go }),
    );

    // #then
    expect(advanced.feeCoverUsdc).toBe(payout.amountIn - payout.amountOut);
  });

  it("covers nothing for a move to Treasury, which the company pays for", async () => {
    // #given
    const treasuryMove = await saveTreasuryMove(db, {
      company: paying.company,
      walletId: paying.wallet.id,
    });
    const toTreasury = await savedQuote("to_treasury", {
      row: { treasuryMoveId: treasuryMove.id },
    });
    const relayerBefore = fakes.chain.state.usdcBalanceOf(
      fakes.relayer.accountId,
    );

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({ quote: toTreasury, beforeDeposit: go }),
    );

    // #then
    expect({
      status: advanced.status,
      feeCover: advanced.feeCoverUsdc,
      relayerPaid:
        relayerBefore -
        fakes.chain.state.usdcBalanceOf(fakes.relayer.accountId),
    }).toEqual({ status: "depositing", feeCover: null, relayerPaid: 0n });
  });
});

describe("OneClick.submitDeposit", () => {
  it("passes a session through when given one, and none otherwise", async () => {
    // #given
    const hop = await savedQuote("base_hop");

    // #when
    await runtime.runPromise(
      Effect.flatMap(OneClick, (client) =>
        Effect.all([
          client.submitDeposit(hop.depositAddress, "tx-1"),
          client.submitDeposit(
            hop.depositAddress,
            "tx-1",
            Redacted.make("a-session"),
          ),
        ]),
      ),
    );

    // #then
    expect(
      callsFor(hop.depositAddress, "submitDeposit").map(
        (entry) => entry.session && Redacted.value(entry.session),
      ),
    ).toEqual([undefined, "a-session"]);
  });
});
