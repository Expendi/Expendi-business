import { and, eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type {
  ConfidentialAccountsShape,
  SignedCompanyIntent,
} from "../../services/intents/confidential-account.js";
import type { OneClickShape } from "../../services/intents/one-click.js";
import type { FundedCompany } from "../helpers/money-in.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes, wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { sessionForQuote } from "../../services/intents/company-session.js";
import { ConfidentialAccounts } from "../../services/intents/confidential-account.js";
import { OneClick } from "../../services/intents/one-click.js";
import { advanceCompanyQuote } from "../../services/intents/quote-deposit.js";
import { isIntentPaid } from "../../services/intents/quote-intent.js";
import { UNSETTLED_REVIEW_MS } from "../../services/intents/quote-settle.js";
import { SendRefused } from "../../services/wallet/privy-wallets.js";
import { settleOpenQuotes } from "../helpers/confidential-delivery.js";
import { saveQuote } from "../helpers/money-in.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { barrier, makeTestRuntime } from "../helpers/runtime.js";

// Serial: it shares one database with the jobs that walk every company, so
// everything a test leaves open is settled again afterwards.

const fakes = makeNearUsdcFakes();
const oneClick = makeFakeOneClick();
oneClick.state.costPerQuote = 0n;

let runtime: AppRuntime;
let db: Database;
let paying: NearUsdcPayingCompany;
let funded: FundedCompany;
const companies: FundedCompany[] = [];

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

async function newCompany(
  options: {
    readonly cap?: bigint;
    readonly balanceHome?: "company_wallet" | "confidential_account";
  } = {},
) {
  paying = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    100n * USDC,
    options.cap,
    options.balanceHome ?? "confidential_account",
  );
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
  companies.push(funded);
}

beforeEach(async () => {
  await newCompany();
});

afterEach(async () => {
  oneClick.state.costPerQuote = 0n;
  for (const company of companies.splice(0)) {
    await settleOpenQuotes(db, company);
  }
});

const organizationId = () => paying.company.organizationId;
const account = () => paying.wallet.address;
const go = () => Effect.succeed({ kind: "go" as const });

const inAccount = (amount: bigint) =>
  oneClick.state.fundConfidential(account(), amount);
const heldInAccount = () =>
  oneClick.state.confidentialBalances.get(account()) ?? 0n;

/**
 * Expendi's float in the company's confidential account, as a delivered fee
 * cover leaves it.
 */
const floatOf = (amount: bigint) =>
  saveQuote(runtime, db, funded, "fee_cover", {
    row: {
      status: "succeeded",
      settledAt: new Date(),
      swappedAmountOut: amount,
    },
  });

/**
 * A USDC payout quote paid out of the account, with a float that covers its
 * cost and the company's session already signed in, so what Privy is asked
 * to sign afterwards is the payout's message and nothing else.
 */
async function payout(
  options: {
    readonly amount?: bigint;
    readonly purpose?: "usdc_payout" | "base_hop";
    readonly slippageBps?: number;
    readonly row?: Partial<typeof intentQuotes.$inferInsert>;
  } = {},
): Promise<IntentQuote> {
  const quote = await saveQuote(
    runtime,
    db,
    funded,
    options.purpose ?? "usdc_payout",
    {
      intentPaid: true,
      ...(options.amount !== undefined && { amount: options.amount }),
      ...(options.slippageBps !== undefined && {
        slippageBps: options.slippageBps,
      }),
      ...(options.row !== undefined && { row: options.row }),
    },
  );
  await runtime.runPromise(sessionForQuote(quote));
  return quote;
}

const row = async (quote: Pick<IntentQuote, "id">): Promise<IntentQuote> => {
  const [found] = await runInScope(
    db,
    { organizationId: organizationId() },
    (tx) => tx.select().from(intentQuotes).where(eq(intentQuotes.id, quote.id)),
  );
  if (!found) throw new Error("quote vanished");
  return found;
};

const change = (
  quote: Pick<IntentQuote, "id">,
  changes: Partial<typeof intentQuotes.$inferInsert>,
) =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx.update(intentQuotes).set(changes).where(eq(intentQuotes.id, quote.id)),
  );

const signings = () =>
  fakes.privy.state.nearSigningRequestsFor(paying.privyWalletId);
const submissionsFor = (quote: IntentQuote) =>
  oneClick.state.submittedIntents.filter(
    (submitted) => submitted.depositAddress === quote.depositAddress,
  );
const callsFor = (quote: IntentQuote, call: string) =>
  oneClick.state.calls.filter(
    (entry) =>
      entry.depositAddress === quote.depositAddress && entry.call === call,
  );

const services = async () => {
  const accounts = await runtime.runPromise(ConfidentialAccounts);
  const calls = { generate: 0, sign: 0 };
  const savedBeforeSubmit: boolean[] = [];
  const submitted: IntentQuote["signedIntent"][] = [];
  const wrappedOneClick: OneClickShape = {
    ...oneClick.service,
    generateIntent: (input, session) => {
      calls.generate += 1;
      return oneClick.service
        .generateIntent(input, session)
        .pipe(Effect.delay("100 millis"));
    },
    submitIntent: (signed, session) =>
      Effect.promise(async () => {
        const [saved] = await runInScope(
          db,
          { organizationId: organizationId() },
          (tx) =>
            tx
              .select({ signedIntent: intentQuotes.signedIntent })
              .from(intentQuotes)
              .where(
                eq(
                  intentQuotes.depositAddress,
                  (
                    JSON.parse(signed.payload.message) as {
                      intents: { receiver_id: string }[];
                    }
                  ).intents[0]?.receiver_id ?? "",
                ),
              ),
        );
        savedBeforeSubmit.push(
          saved?.signedIntent != null && sameJson(saved.signedIntent, signed),
        );
        submitted.push(signed);
      }).pipe(Effect.zipRight(oneClick.service.submitIntent(signed, session))),
  };
  const wrappedAccounts = (
    afterSigning?: (signed: SignedCompanyIntent) => Effect.Effect<void>,
  ): ConfidentialAccountsShape => ({
    ...accounts,
    signIntent: (input) => {
      calls.sign += 1;
      return accounts
        .signIntent(input)
        .pipe(Effect.tap((signed) => afterSigning?.(signed) ?? Effect.void));
    },
  });
  return {
    calls,
    savedBeforeSubmit,
    submitted,
    wrappedOneClick,
    wrappedAccounts,
  };
};

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  }
  return value;
}

type Wrapped = Awaited<ReturnType<typeof services>>;

const advance = (quote: IntentQuote, wrapped?: Wrapped) =>
  runtime.runPromise(
    advanceCompanyQuote({ quote, beforeDeposit: go }).pipe(
      wrapped === undefined
        ? (effect) => effect
        : (effect) =>
            effect.pipe(
              Effect.provideService(OneClick, wrapped.wrappedOneClick),
              Effect.provideService(
                ConfidentialAccounts,
                wrapped.wrappedAccounts(),
              ),
            ),
    ),
  );

describe("a quote paid out of a confidential account", () => {
  it("is told apart by its deposit type alone", () => {
    expect(isIntentPaid({ depositType: "CONFIDENTIAL_INTENTS" })).toBe(true);
    expect(isIntentPaid({ depositType: "ORIGIN_CHAIN" })).toBe(false);
    expect(isIntentPaid({ depositType: "INTENTS" })).toBe(false);
  });

  it("is paid by one signed message, saved before it is submitted, and settled from 1Click's word", async () => {
    // #given a payout the account can pay, and its cost covered
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    const wrapped = await services();
    const signedBefore = signings();

    // #when
    const advanced = await advance(quote, wrapped);

    // #then the message was signed once, saved with its deadline, submitted
    // as saved, and the account was debited by 1Click, not by a chain send
    expect({
      status: advanced.status,
      signed: signings() - signedBefore,
      signIntentCalls: wrapped.calls.sign,
      savedBeforeSubmit: wrapped.savedBeforeSubmit,
      hasMessage: advanced.signedIntent !== null,
      hasDeadline: advanced.intentDeadline !== null,
      submittedAt: advanced.intentSubmittedAt !== null,
      hash: advanced.intentHash !== null,
      balance: heldInAccount(),
      send: [
        advanced.companyWalletSendId,
        advanced.depositTxHash,
        advanced.depositRegistrationTxHash,
        advanced.feeCoverUsdc,
      ],
    }).toEqual({
      status: "depositing",
      signed: 1,
      signIntentCalls: 1,
      savedBeforeSubmit: [true],
      hasMessage: true,
      hasDeadline: true,
      submittedAt: true,
      hash: true,
      balance: 50n * USDC - quote.amountIn,
      send: [null, null, null, null],
    });

    // #when 1Click reports it delivered
    oneClick.state.deliverIntentPayout(quote.depositAddress);
    const settled = await advance(advanced, wrapped);

    // #then
    expect(settled.status).toBe("succeeded");
  });

  it("asks 1Click about it only with the company's session", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);

    // #when
    await advance(quote);

    // #then
    expect(
      oneClick.state.calls
        .filter((entry) => entry.depositAddress === quote.depositAddress)
        .map((entry) => [entry.call, entry.session !== undefined]),
    ).toEqual([
      ["generateIntent", true],
      ["submitIntent", true],
      ["status", true],
    ]);
  });
});

describe("a quote that touches no confidential account", () => {
  it("goes down today's path: a relayer cover, a send from the company wallet, no signed message", async () => {
    // #given
    await newCompany({ balanceHome: "company_wallet" });
    const hop = await saveQuote(runtime, db, funded, "base_hop");
    fakes.chain.state.createAccount(hop.depositAddress);
    const signedBefore = signings();

    // #when
    const advanced = await advance(hop);

    // #then
    expect({
      status: advanced.status,
      cover: advanced.feeCoverUsdc,
      send: advanced.companyWalletSendId !== null,
      deposit: advanced.depositTxHash !== null,
      message: advanced.signedIntent,
      intentCalls: oneClick.state.calls.filter(
        (entry) =>
          entry.depositAddress === hop.depositAddress &&
          (entry.call === "generateIntent" || entry.call === "submitIntent"),
      ),
      sessions: callsFor(hop, "status").map((entry) => entry.session),
      companyWalletSignings: signings() - signedBefore,
    }).toEqual({
      status: "depositing",
      cover: hop.amountIn - hop.amountOut,
      send: true,
      deposit: true,
      message: null,
      intentCalls: [],
      sessions: [undefined],
      companyWalletSignings: 1,
    });
  });
});

describe("what must hold before a message is asked for", () => {
  it("expires a quote with under 3 minutes left, with nothing generated", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout({
      row: { deadline: new Date(Date.now() + 2 * 60_000) },
    });
    inAccount(50n * USDC);

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      status: advanced.status,
      generated: callsFor(quote, "generateIntent").length,
      started: advanced.depositStartedAt,
    }).toEqual({ status: "expired", generated: 0, started: null });
  });

  it("waits for the fee cover, and does nothing until the float covers the cost", async () => {
    // #given a Base hop that costs more than the float holds
    oneClick.state.costPerQuote = 4_465n;
    const quote = await payout({ purpose: "base_hop" });
    inAccount(50n * USDC);

    // #when
    const waiting = await advance(quote);
    const generatedWhileWaiting = callsFor(quote, "generateIntent").length;
    await floatOf(USDC);
    const covered = await advance(waiting);

    // #then
    expect({
      before: [waiting.status, generatedWhileWaiting, waiting.depositStartedAt],
      after: covered.status,
    }).toEqual({ before: ["quoted", 0, null], after: "depositing" });
  });

  it("covers nothing for a payout that costs nothing, even with the float below zero", async () => {
    // #given a quote delivering what it takes in, and no float at all
    oneClick.state.costPerQuote = 0n;
    const quote = await payout({ slippageBps: 0 });
    inAccount(50n * USDC);

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      costs: quote.amountIn - quote.amountOut,
      status: advanced.status,
    }).toEqual({ costs: 0n, status: "depositing" });
  });

  it("holds the quote when the account holds less than it needs", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(quote.amountIn - 1n);

    // #when
    const held = await advance(quote);
    const generatedWhileHeld = callsFor(quote, "generateIntent").length;
    inAccount(1n);
    const started = await advance(held);

    // #then
    expect({
      held: [held.status, generatedWhileHeld],
      started: started.status,
    }).toEqual({ held: ["quoted", 0], started: "depositing" });
  });

  it("counts the wallet's other quotes in flight against the balance", async () => {
    // #given the account can pay one of two payouts; the first's message is
    // signed but not yet accepted, so the balance hasn't fallen
    await floatOf(USDC);
    const first = await payout();
    const second = await payout();
    inAccount(first.amountIn + 1_000n);
    oneClick.state.failNextSubmit("unknown");
    const firstAdvanced = await advance(first);

    // #when
    let gateAsked = 0;
    const secondAdvanced = await runtime.runPromise(
      advanceCompanyQuote({
        quote: second,
        beforeDeposit: () => {
          gateAsked += 1;
          return go();
        },
      }),
    );

    // #then the second waits without even asking its caller to take its
    // barrier, and goes ahead once the first has settled
    expect({
      first: firstAdvanced.status,
      second: [
        secondAdvanced.status,
        callsFor(second, "generateIntent").length,
        gateAsked,
      ],
    }).toEqual({ first: "depositing", second: ["quoted", 0, 0] });

    // #when the first is delivered, the balance is read afresh
    oneClick.state.deliverIntentPayout(first.depositAddress);
    await advance(firstAdvanced);
    inAccount(second.amountIn);
    const later = await advance(secondAdvanced);

    // #then
    expect(later.status).toBe("depositing");
  });

  it("never starts two quotes the balance can't carry together, even when both passed the first check", async () => {
    // #given both pass every check before either has started
    await floatOf(USDC);
    const first = await payout();
    const second = await payout();
    inAccount(first.amountIn + 1_000n);
    const bothAsked = barrier(2);
    const hold = () =>
      Effect.promise(bothAsked).pipe(Effect.as({ kind: "go" as const }));

    // #when
    await Promise.all(
      [first, second].map((quote) =>
        runtime.runPromise(advanceCompanyQuote({ quote, beforeDeposit: hold })),
      ),
    );

    // #then
    const started = [await row(first), await row(second)].filter(
      (quote) => quote.status !== "quoted",
    );
    expect(started).toHaveLength(1);
  });

  it("never starts two fee-covered quotes on a float that covers one, even when both passed the gate", async () => {
    // #given a float for one hop's cost, and two hops that both pass every
    // unlocked check before either has started
    oneClick.state.costPerQuote = 4_465n;
    const first = await payout({ purpose: "base_hop" });
    const second = await payout({ purpose: "base_hop" });
    const cost = first.amountIn - first.amountOut;
    await floatOf(cost + cost / 2n);
    inAccount(50n * USDC);
    const bothAsked = barrier(2);
    const hold = () =>
      Effect.promise(bothAsked).pipe(Effect.as({ kind: "go" as const }));

    // #when
    await Promise.all(
      [first, second].map((quote) =>
        runtime.runPromise(advanceCompanyQuote({ quote, beforeDeposit: hold })),
      ),
    );

    // #then
    const statuses = [(await row(first)).status, (await row(second)).status];
    expect(statuses.sort()).toEqual(["depositing", "quoted"]);
  });

  it("starts a single fee-covered quote the float covers", async () => {
    // #given
    oneClick.state.costPerQuote = 4_465n;
    const quote = await payout({ purpose: "base_hop" });
    await floatOf(USDC);
    inAccount(50n * USDC);

    // #when
    const advanced = await advance(quote);

    // #then
    expect(advanced.status).toBe("depositing");
  });

  it("lets the caller abandon the quote: expired, nothing generated", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({
        quote,
        beforeDeposit: () =>
          Effect.succeed({ kind: "abandon" as const, reason: "paused" }),
      }),
    );

    // #then
    expect({
      status: advanced.status,
      failure: advanced.failure,
      generated: callsFor(quote, "generateIntent").length,
    }).toEqual({ status: "expired", failure: "paused", generated: 0 });
  });

  it("leaves the quote as it is when the company can't be signed in", async () => {
    // #given
    await floatOf(USDC);
    const quote = await saveQuote(runtime, db, funded, "usdc_payout", {
      intentPaid: true,
    });
    inAccount(50n * USDC);
    const accounts = await runtime.runPromise(ConfidentialAccounts);
    const broken: ConfidentialAccountsShape = {
      ...accounts,
      session: () =>
        Effect.fail(
          new SendRefused({
            message: "no",
            status: 403,
            policyViolation: false,
          }),
        ),
    };

    // #when
    const advanced = await runtime.runPromise(
      advanceCompanyQuote({ quote, beforeDeposit: go }).pipe(
        Effect.provideService(ConfidentialAccounts, broken),
      ),
    );

    // #then
    expect({
      status: advanced.status,
      generated: callsFor(quote, "generateIntent").length,
      signed: submissionsFor(quote).length,
    }).toEqual({ status: "quoted", generated: 0, signed: 0 });
  });
});

describe("the message", () => {
  it("is retried when 1Click can't generate it, then signed", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    oneClick.state.failNextGenerate();
    const signedBefore = signings();

    // #when
    const first = await advance(quote);
    const second = await advance(first);

    // #then nothing was signed until a message existed
    expect({
      first: [first.status, first.signedIntent],
      second: second.status,
      signed: signings() - signedBefore,
    }).toEqual({
      first: ["depositing", null],
      second: "depositing",
      signed: 1,
    });
  });

  it("fails the quote, nothing moved, when no message is signed before the deadline's margin", async () => {
    // #given a started quote whose message can't be generated
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    oneClick.state.failNextGenerate();
    const started = await advance(quote);
    await change(started, { deadline: new Date(Date.now() + 2 * 60_000) });
    const signedBefore = signings();

    // #when
    const advanced = await advance(started);

    // #then
    expect({
      status: advanced.status,
      failure: advanced.failure,
      signed: signings() - signedBefore,
      submitted: submissionsFor(quote).length,
    }).toEqual({
      status: "failed",
      failure:
        "No message was signed before the quote's deadline. Nothing moved.",
      signed: 0,
      submitted: 0,
    });
  });

  it.each([
    "recipient",
    "signer",
    "receiver",
    "token_id",
    "amount_not_the_quote",
  ] as const)(
    "fails the quote when the message fails the check (%s): nothing was signed, nothing submitted",
    async (reason) => {
      // #given
      await floatOf(USDC);
      const quote = await payout();
      inAccount(50n * USDC);
      oneClick.state.badNextIntent(reason);
      const signedBefore = signings();

      // #when
      const advanced = await advance(quote);

      // #then
      expect({
        status: advanced.status,
        message: advanced.signedIntent,
        signed: signings() - signedBefore,
        submitted: submissionsFor(quote).length,
        explained: advanced.failure?.includes("Nothing was signed"),
      }).toEqual({
        status: "failed",
        message: null,
        signed: 0,
        submitted: 0,
        explained: true,
      });
    },
  );

  it("is refused by the spend cap at signing, before Privy is asked", async () => {
    // #given a company whose cap is under the payout
    await newCompany({ cap: 1n * USDC });
    await floatOf(USDC);
    const quote = await payout({ amount: 5n * USDC });
    inAccount(50n * USDC);
    const signedBefore = signings();

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      status: advanced.status,
      signed: signings() - signedBefore,
      submitted: submissionsFor(quote).length,
    }).toEqual({ status: "failed", signed: 0, submitted: 0 });
  });

  it("fails the quote when Privy refuses to sign", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    fakes.privy.state.nextNearSignings("refused");

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      status: advanced.status,
      message: advanced.signedIntent,
      submitted: submissionsFor(quote).length,
    }).toEqual({ status: "failed", message: null, submitted: 0 });
  });

  it("is generated and signed again when Privy's answer was unclear: the first signature never left Privy", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    fakes.privy.state.nextNearSignings("unavailable");

    // #when
    const first = await advance(quote);
    const second = await advance(first);

    // #then
    expect({
      first: [first.status, first.signedIntent],
      second: [second.status, second.intentHash !== null],
      submitted: submissionsFor(quote).length,
    }).toEqual({
      first: ["depositing", null],
      second: ["depositing", true],
      submitted: 1,
    });
  });

  it("can only be submitted if it was saved: a crash after signing leaves a signature nothing can submit", async () => {
    // #given a process that stops right after Privy signed, before the save
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    const wrapped = await services();
    const signedBefore = signings();

    // #when
    const crashed = await runtime.runPromiseExit(
      advanceCompanyQuote({ quote, beforeDeposit: go }).pipe(
        Effect.provideService(OneClick, wrapped.wrappedOneClick),
        Effect.provideService(
          ConfidentialAccounts,
          wrapped.wrappedAccounts(() => Effect.die("the process stopped")),
        ),
      ),
    );
    const afterCrash = await row(quote);
    const recovered = await advance(afterCrash, wrapped);

    // #then the lost signature was never submitted; the next run's was
    expect({
      crashed: Exit.isFailure(crashed),
      lost: [afterCrash.status, afterCrash.signedIntent],
      submittedMessages: wrapped.submitted.length,
      signed: signings() - signedBefore,
      recovered: [recovered.status, recovered.intentHash !== null],
    }).toEqual({
      crashed: true,
      lost: ["depositing", null],
      submittedMessages: 1,
      signed: 2,
      recovered: ["depositing", true],
    });
    expect(sameJson(wrapped.submitted[0], recovered.signedIntent)).toBe(true);
  });

  it("is signed once when two runs drive the quote at the same time", async () => {
    // #given a started quote with nothing signed, and a slow 1Click
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    oneClick.state.failNextGenerate();
    const started = await advance(quote);
    const wrapped = await services();
    const signedBefore = signings();

    // #when
    await Promise.all([advance(started, wrapped), advance(started, wrapped)]);
    const final = await row(quote);

    // #then
    expect({
      signed: signings() - signedBefore,
      signIntentCalls: wrapped.calls.sign,
      hash: final.intentHash !== null,
      distinctMessages: new Set(
        wrapped.submitted.map((message) => JSON.stringify(sortKeys(message))),
      ).size,
    }).toEqual({
      signed: 1,
      signIntentCalls: 1,
      hash: true,
      distinctMessages: 1,
    });
  });
});

describe("submitting the saved message", () => {
  it("submits the same bytes again, and never asks Privy to sign again, when the first submit was lost", async () => {
    // #given a message signed and saved, whose submit got no answer
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    oneClick.state.failNextSubmit("unknown");
    const wrapped = await services();
    const signedBefore = signings();
    const first = await advance(quote, wrapped);

    // #when
    const second = await advance(first, wrapped);

    // #then
    expect({
      first: [first.status, first.intentHash, first.intentSubmittedAt !== null],
      second: [second.status, second.intentHash !== null],
      signed: signings() - signedBefore,
      attempts: wrapped.submitted.length,
      identical: sameJson(wrapped.submitted[0], wrapped.submitted[1]),
      equalToSaved: sameJson(wrapped.submitted[1], second.signedIntent),
      savedBeforeEach: wrapped.savedBeforeSubmit,
      debitedOnce: heldInAccount(),
    }).toEqual({
      first: ["depositing", null, true],
      second: ["depositing", true],
      signed: 1,
      attempts: 2,
      identical: true,
      equalToSaved: true,
      savedBeforeEach: [true, true],
      debitedOnce: 50n * USDC - quote.amountIn,
    });
  });

  it("keeps 1Click's refusal on the row and submits again", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    oneClick.state.failNextSubmit("refused");
    const first = await advance(quote);

    // #when
    const second = await advance(first);

    // #then
    expect({
      first: [first.status, first.failure?.startsWith("1Click refused")],
      second: [second.status, second.failure, second.intentHash !== null],
      attempts: submissionsFor(quote).map((submitted) => submitted.outcome),
    }).toEqual({
      first: ["depositing", true],
      second: ["depositing", null, true],
      attempts: ["refused", "accepted"],
    });
  });

  it("stops submitting inside the last 3 minutes before the quote's deadline", async () => {
    // #given a saved message not yet accepted
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    oneClick.state.failNextSubmit("unknown");
    const first = await advance(quote);
    await change(first, { deadline: new Date(Date.now() + 2 * 60_000) });

    // #when
    const second = await advance(first);

    // #then
    expect({
      status: second.status,
      hash: second.intentHash,
      attempts: submissionsFor(quote).length,
    }).toEqual({ status: "depositing", hash: null, attempts: 1 });
  });

  it("does nothing for a quote that is already accepted but wait for 1Click", async () => {
    // #given
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    const accepted = await advance(quote);
    const signedBefore = signings();

    // #when
    const again = await advance(accepted);

    // #then
    expect({
      status: again.status,
      attempts: submissionsFor(quote).length,
      signed: signings() - signedBefore,
    }).toEqual({ status: "depositing", attempts: 1, signed: 0 });
  });
});

describe("what 1Click says afterwards", () => {
  async function accepted() {
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    return advance(quote);
  }

  it("leaves a quote 1Click is silent about until 30 minutes past its deadline, then for a person", async () => {
    // #given
    const quote = await accepted();
    const still = await advance(quote);
    await change(quote, {
      deadline: new Date(Date.now() - UNSETTLED_REVIEW_MS - 60_000),
    });

    // #when
    const review = await advance(still);

    // #then
    expect({ still: still.status, review: review.status }).toEqual({
      still: "depositing",
      review: "needs_review",
    });
  });

  it("settles a late SUCCESS from review, and a REFUNDED one too", async () => {
    // #given two quotes in review
    const delivered = await accepted();
    await floatOf(USDC);
    const refunded = await payout();
    inAccount(50n * USDC);
    await advance(refunded);
    for (const quote of [delivered, refunded]) {
      await change(quote, { status: "needs_review" });
    }
    oneClick.state.deliverIntentPayout(delivered.depositAddress);
    oneClick.state.refundIntentPayout(refunded.depositAddress);

    // #when
    const settled = await Promise.all([
      advance(await row(delivered)),
      advance(await row(refunded)),
    ]);

    // #then
    expect(settled.map((quote) => quote.status)).toEqual([
      "succeeded",
      "refunded",
    ]);
  });

  it("leaves a signed message that never ran in review until its own deadline has passed", async () => {
    // #given 1Click still waiting for the deposit, the message's deadline ahead
    const quote = await accepted();
    await change(quote, { status: "needs_review" });

    // #when
    const waiting = await advance(await row(quote));

    // #then
    expect({
      status: waiting.status,
      checkedAgain: waiting.oneClickStatus,
    }).toEqual({ status: "needs_review", checkedAgain: "PENDING_DEPOSIT" });
  });

  it("fails it, nothing moved, once its deadline is more than 5 minutes past and 1Click still waits for the deposit", async () => {
    // #given
    const quote = await accepted();
    await change(quote, {
      status: "needs_review",
      intentDeadline: new Date(Date.now() - 10 * 60_000),
    });

    // #when
    const failed = await advance(await row(quote));

    // #then
    expect({
      status: failed.status,
      failure: failed.failure,
      settledAfterDeadline:
        failed.settledAt !== null &&
        failed.intentDeadline !== null &&
        failed.settledAt > failed.intentDeadline,
    }).toEqual({
      status: "failed",
      failure: "The signed message expired unused. Nothing moved.",
      settledAfterDeadline: true,
    });
  });

  it("does not fail it before the grace of 5 minutes after its deadline", async () => {
    // #given
    const quote = await accepted();
    await change(quote, {
      status: "needs_review",
      intentDeadline: new Date(Date.now() - 2 * 60_000),
    });

    // #when
    const waiting = await advance(await row(quote));

    // #then
    expect(waiting.status).toBe("needs_review");
  });

  it.each([
    [
      "1Click has a deposit",
      { status: "PROCESSING" as const, depositedAmount: 5_000_000n },
    ],
    [
      "1Click reports it delivered",
      { status: "SUCCESS" as const, depositedAmount: 5_000_000n },
    ],
  ])("does not fail it when %s", async (_name, reported) => {
    // #given
    const quote = await accepted();
    await change(quote, {
      status: "needs_review",
      intentDeadline: new Date(Date.now() - 10 * 60_000),
    });
    oneClick.state.setStatus(quote.depositAddress, reported);

    // #when
    const advanced = await advance(await row(quote));

    // #then
    expect(advanced.status).not.toBe("failed");
  });

  it("does not fail it on an old answer when 1Click can't be asked now", async () => {
    // #given 1Click answered PENDING_DEPOSIT once, then goes quiet
    const quote = await accepted();
    await change(quote, {
      status: "needs_review",
      intentDeadline: new Date(Date.now() - 10 * 60_000),
      oneClickStatus: "PENDING_DEPOSIT",
      oneClickCheckedAt: new Date(Date.now() - 60_000),
    });
    oneClick.state.failNextStatus();

    // #when
    const advanced = await advance(await row(quote));

    // #then
    expect(advanced.status).toBe("needs_review");
  });

  it("never lets the database fail a signed quote before its message's deadline", async () => {
    // #given
    const quote = await accepted();

    // #when
    const early = change(quote, { status: "failed", settledAt: new Date() });

    // #then
    await expect(early).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_signed_fails_after_its_deadline" },
    });
  });
});

describe("a quote kept by a company that was switched back", () => {
  it("is still paid by message: its own columns decide", async () => {
    // #given an intent-paid quote of a company whose balance home changed
    await floatOf(USDC);
    const quote = await payout();
    inAccount(50n * USDC);
    await runInScope(db, { organizationId: organizationId() }, (tx) =>
      tx
        .update(wallets)
        .set({ balanceHome: "company_wallet" })
        .where(and(eq(wallets.id, funded.walletId))),
    );

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      status: advanced.status,
      message: advanced.signedIntent !== null,
      send: advanced.companyWalletSendId,
    }).toEqual({ status: "depositing", message: true, send: null });
  });
});
