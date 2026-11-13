import { Effect, Either, Exit, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import type {
  OneClickQuoteRequest,
  OneClickSession,
  OneClickSignedIntent,
  OneClickUnsignedIntent,
} from "../../services/intents/one-click.js";
import { checkCompanyIntent } from "../../services/intents/confidential-account.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { randomNearAccount, TEST_USDC_CONTRACT } from "../helpers/near.js";
import { makeFakeOneClick } from "../helpers/one-click.js";

// The other tests lean on the fake 1Click behaving like the real one for a
// confidential account, so what they lean on is checked here.

const signInOf = (account: string): OneClickSignedIntent => ({
  standard: "nep413",
  payload: {
    message: JSON.stringify({ signer_id: account, intents: [] }),
    nonce: "",
    recipient: "intents.near",
  },
  public_key: "",
  signature: "",
});

const moveIn = (account: string): OneClickQuoteRequest => ({
  dry: false,
  swapType: "EXACT_INPUT",
  originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
  destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
  amount: 5_000_000n,
  recipient: account,
  recipientType: "CONFIDENTIAL_INTENTS",
  refundTo: account,
  deadline: new Date(Date.now() + 600_000),
  slippageBps: 0,
});

const publicHop = (account: string): OneClickQuoteRequest => ({
  ...moveIn(account),
  recipientType: undefined,
});

function setup() {
  const fake = makeFakeOneClick();
  const signIn = async (account: string): Promise<OneClickSession> =>
    (await Effect.runPromise(fake.service.authenticate(signInOf(account))))
      .session;
  const failureOf = async <A>(effect: Effect.Effect<A, unknown>) => {
    const exit = await Effect.runPromiseExit(effect);
    return Exit.isFailure(exit) && exit.cause._tag === "Fail"
      ? exit.cause.error
      : exit;
  };
  return { ...fake, signIn, failureOf };
}

describe("the fake 1Click, for a confidential account", () => {
  it.each([
    ["recipient", { recipientType: "CONFIDENTIAL_INTENTS" as const }],
    ["deposit", { depositType: "CONFIDENTIAL_INTENTS" as const }],
    ["refund", { refundType: "CONFIDENTIAL_INTENTS" as const }],
  ])(
    "refuses a quote with a confidential %s that comes without a session",
    async (_name, sides) => {
      // #given
      const { service, state, failureOf } = setup();
      const account = randomNearAccount();

      // #when
      const error = await failureOf(
        service.quote({ ...publicHop(account), ...sides }),
      );

      // #then it is refused as unauthorized, and no quote exists
      expect({ error, quotes: state.quotes.size }).toMatchObject({
        error: { _tag: "OneClickRefused", httpStatus: 401 },
        quotes: 0,
      });
    },
  );

  it("quotes a confidential move for a company that has signed in", async () => {
    // #given
    const { service, state, signIn } = setup();
    const account = randomNearAccount();
    const session = await signIn(account);

    // #when
    const quote = await Effect.runPromise(
      service.quote(moveIn(account), session),
    );

    // #then
    expect({
      firm: !quote.dry,
      sessions: state.calls.map((call) => call.session === session),
    }).toEqual({ firm: true, sessions: [true] });
  });

  it("quotes a public move without a session, as before", async () => {
    // #given
    const { service } = setup();

    // #when
    const quote = await Effect.runPromise(
      service.quote(publicHop(randomNearAccount())),
    );

    // #then
    expect(quote.dry).toBe(false);
  });

  it("hears nothing of a confidential quote without the company's own session", async () => {
    // #given
    const { service, signIn, failureOf } = setup();
    const account = randomNearAccount();
    const quote = await Effect.runPromise(
      service.quote(moveIn(account), await signIn(account)),
    );
    if (quote.dry) throw new Error("expected a firm quote");
    const strangers = await signIn(randomNearAccount());

    // #when
    const outcomes = await Promise.all([
      failureOf(service.status(quote.depositAddress)),
      failureOf(service.status(quote.depositAddress, strangers)),
    ]);

    // #then
    expect(outcomes).toMatchObject([
      { _tag: "OneClickRefused", httpStatus: 404 },
      { _tag: "OneClickRefused", httpStatus: 404 },
    ]);
  });

  it("reports a confidential quote to any session of its account, the first sign-in included", async () => {
    // #given two sign-ins of one account
    const { service, signIn } = setup();
    const account = randomNearAccount();
    const first = await signIn(account);
    const second = await signIn(account);
    const quote = await Effect.runPromise(
      service.quote(moveIn(account), first),
    );
    if (quote.dry) throw new Error("expected a firm quote");

    // #when
    const statuses = await Promise.all(
      [first, second].map((session) =>
        Effect.runPromise(service.status(quote.depositAddress, session)),
      ),
    );

    // #then
    expect(statuses.map((status) => status.status)).toEqual([
      "PENDING_DEPOSIT",
      "PENDING_DEPOSIT",
    ]);
  });

  it("delivers to the account: SUCCESS with the amount out, and a balance that rises", async () => {
    // #given
    const { service, state, signIn } = setup();
    const account = randomNearAccount();
    const session = await signIn(account);
    const quote = await Effect.runPromise(
      service.quote(moveIn(account), session),
    );
    if (quote.dry) throw new Error("expected a firm quote");
    state.fundConfidential(account, 1_000_000n);

    // #when
    state.deliverConfidential(quote.depositAddress, 4_995_535n);
    const status = await Effect.runPromise(
      service.status(quote.depositAddress, session),
    );
    const balances = await Effect.runPromise(service.balances(session));

    // #then
    expect({
      status: status.status,
      amountOut: status.amountOut,
      balances: balances.map((balance) => balance.available),
    }).toEqual({
      status: "SUCCESS",
      amountOut: 4_995_535n,
      balances: [5_995_535n],
    });
  });

  it("reads a balance only for a session it issued", async () => {
    // #given
    const { service, failureOf } = setup();

    // #when
    const error = await failureOf(
      service.balances(Redacted.make("not-a-session")),
    );

    // #then
    expect(error).toMatchObject({ _tag: "OneClickRefused", httpStatus: 401 });
  });
});

describe("the fake 1Click, for a payment out of a confidential account", () => {
  const payout = (account: string): OneClickQuoteRequest => ({
    dry: false,
    swapType: "EXACT_OUTPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    amount: 5_000_000n,
    recipient: "0x1111111111111111111111111111111111111111",
    refundTo: account,
    depositType: "CONFIDENTIAL_INTENTS",
    refundType: "CONFIDENTIAL_INTENTS",
    deadline: new Date(Date.now() + 600_000),
    slippageBps: 10,
  });

  async function paid() {
    const fake = setup();
    const account = randomNearAccount();
    const session = await fake.signIn(account);
    const quote = await Effect.runPromise(
      fake.service.quote(payout(account), session),
    );
    if (quote.dry) throw new Error("expected a firm quote");
    return { ...fake, account, session, quote };
  }

  /** A message as the signer would send it back, signed by nothing. */
  const signed = (unsigned: OneClickUnsignedIntent): OneClickSignedIntent => ({
    standard: "nep413",
    payload: unsigned,
    public_key: "ed25519:key",
    signature: "ed25519:signature",
  });

  it("generates the one message checkCompanyIntent accepts for the quote", async () => {
    // #given
    const { service, session, quote, account } = await paid();

    // #when
    const unsigned = await Effect.runPromise(
      service.generateIntent(
        { depositAddress: quote.depositAddress, signerId: account },
        session,
      ),
    );
    const checked = checkCompanyIntent({
      unsigned,
      companyAccountId: account,
      depositAddress: quote.depositAddress,
      amountIn: quote.amountIn,
      spendCap: quote.amountIn,
      usdcContractId: TEST_USDC_CONTRACT,
      now: new Date(),
    });

    // #then a transfer of exactly the amount in, three days out
    expect(checked).toMatchObject({
      _tag: "Right",
      right: { amount: quote.amountIn },
    });
    expect(
      Either.isRight(checked) &&
        Math.round(
          (checked.right.deadline.getTime() - Date.now()) / 86_400_000,
        ),
    ).toBe(3);
  });

  it.each([
    "recipient",
    "signer",
    "receiver",
    "token_id",
    "amount_not_the_quote",
  ] as const)(
    "generates a message that fails the check as %s when told to",
    async (reason) => {
      // #given
      const { service, state, session, quote, account } = await paid();
      state.badNextIntent(reason);

      // #when
      const unsigned = await Effect.runPromise(
        service.generateIntent(
          { depositAddress: quote.depositAddress, signerId: account },
          session,
        ),
      );
      const checked = checkCompanyIntent({
        unsigned,
        companyAccountId: account,
        depositAddress: quote.depositAddress,
        amountIn: quote.amountIn,
        spendCap: quote.amountIn,
        usdcContractId: TEST_USDC_CONTRACT,
        now: new Date(),
      });

      // #then
      expect(Either.isLeft(checked) && checked.left.reason).toBe(reason);
    },
  );

  it("generates only for the account that pays the quote, with its own session", async () => {
    // #given
    const { service, signIn, failureOf, quote, account } = await paid();
    const stranger = randomNearAccount();

    // #when
    const outcomes = await Promise.all([
      failureOf(
        service.generateIntent(
          { depositAddress: quote.depositAddress, signerId: account },
          await signIn(stranger),
        ),
      ),
      failureOf(
        service.generateIntent(
          { depositAddress: quote.depositAddress, signerId: stranger },
          await signIn(stranger),
        ),
      ),
    ]);

    // #then
    expect(outcomes).toMatchObject([
      { _tag: "OneClickRefused", httpStatus: 404 },
      { _tag: "OneClickRefused", httpStatus: 404 },
    ]);
  });

  it("fails the next generate when told to, once", async () => {
    // #given
    const { service, state, session, quote, account, failureOf } = await paid();
    state.failNextGenerate();
    const input = { depositAddress: quote.depositAddress, signerId: account };

    // #when
    const outcomes = [
      await failureOf(service.generateIntent(input, session)),
      await Effect.runPromise(service.generateIntent(input, session)),
    ];

    // #then
    expect([
      (outcomes[0] as { _tag: string })._tag,
      typeof (outcomes[1] as { message: string }).message,
    ]).toEqual(["OneClickOutcomeUnknown", "string"]);
  });

  it("takes the amount in from the account when a signed message is submitted, once however often it is submitted", async () => {
    // #given
    const { service, state, session, quote, account } = await paid();
    state.fundConfidential(account, 50_000_000n);
    const message = signed(
      await Effect.runPromise(
        service.generateIntent(
          { depositAddress: quote.depositAddress, signerId: account },
          session,
        ),
      ),
    );

    // #when
    const first = await Effect.runPromise(
      service.submitIntent(message, session),
    );
    const second = await Effect.runPromise(
      service.submitIntent(message, session),
    );
    const balances = await Effect.runPromise(service.balances(session));

    // #then
    expect({
      sameHash: first.intentHash === second.intentHash,
      balance: balances.map((balance) => balance.available),
      recorded: state.submittedIntents.map((entry) => entry.outcome),
    }).toEqual({
      sameHash: true,
      balance: [50_000_000n - quote.amountIn],
      recorded: ["accepted", "accepted"],
    });
  });

  it("refuses a submit the account can't cover, and one under another session", async () => {
    // #given
    const { service, signIn, session, quote, account, failureOf } =
      await paid();
    const message = signed(
      await Effect.runPromise(
        service.generateIntent(
          { depositAddress: quote.depositAddress, signerId: account },
          session,
        ),
      ),
    );

    // #when
    const outcomes = await Promise.all([
      failureOf(service.submitIntent(message, session)),
      failureOf(
        service.submitIntent(message, await signIn(randomNearAccount())),
      ),
    ]);

    // #then
    expect(outcomes).toMatchObject([
      { _tag: "OneClickRefused", httpStatus: 400 },
      { _tag: "OneClickRefused", httpStatus: 401 },
    ]);
  });

  it("fails the next submit as refused or unknown, taking nothing", async () => {
    // #given
    const { service, state, session, quote, account, failureOf } = await paid();
    state.fundConfidential(account, 50_000_000n);
    const message = signed(
      await Effect.runPromise(
        service.generateIntent(
          { depositAddress: quote.depositAddress, signerId: account },
          session,
        ),
      ),
    );
    state.failNextSubmit("refused", "unknown");

    // #when
    const outcomes = [
      await failureOf(service.submitIntent(message, session)),
      await failureOf(service.submitIntent(message, session)),
    ];

    // #then
    expect({
      errors: outcomes.map((outcome) => (outcome as { _tag: string })._tag),
      balance: state.confidentialBalances.get(account),
      recorded: state.submittedIntents.map((entry) => entry.outcome),
    }).toEqual({
      errors: ["OneClickRefused", "OneClickOutcomeUnknown"],
      balance: 50_000_000n,
      recorded: ["refused", "unknown"],
    });
  });

  it("reports a paid quote only to a session of the account that pays it", async () => {
    // #given
    const { service, signIn, session, quote, failureOf } = await paid();

    // #when
    const outcomes = [
      await Effect.runPromise(service.status(quote.depositAddress, session)),
      await failureOf(service.status(quote.depositAddress)),
      await failureOf(
        service.status(quote.depositAddress, await signIn(randomNearAccount())),
      ),
    ];

    // #then
    expect(outcomes).toMatchObject([
      { status: "PENDING_DEPOSIT" },
      { _tag: "OneClickRefused", httpStatus: 404 },
      { _tag: "OneClickRefused", httpStatus: 404 },
    ]);
  });

  it("delivers the payout, then returns the unused part of an exact-amount-out quote by itself, unreported", async () => {
    // #given a payout that took less than the amount in
    const { service, state, session, quote, account } = await paid();
    state.fundConfidential(account, 50_000_000n);
    const taken = quote.amountIn - 4_000n;

    // #when
    state.deliverIntentPayout(quote.depositAddress, { swappedAmountIn: taken });
    const delivered = await Effect.runPromise(
      service.status(quote.depositAddress, session),
    );
    const returned = state.returnUnused(quote.depositAddress);

    // #then
    expect({
      status: delivered.status,
      swappedIn: delivered.amountIn,
      refunded: delivered.refundedAmount,
      returned,
      balance: state.confidentialBalances.get(account),
    }).toEqual({
      status: "SUCCESS",
      swappedIn: taken,
      refunded: null,
      returned: 4_000n,
      balance: 50_000_000n + 4_000n,
    });
  });

  it("refunds a payout: the whole amount in is back", async () => {
    // #given
    const { service, state, session, quote, account } = await paid();
    state.fundConfidential(account, 50_000_000n);

    // #when
    state.refundIntentPayout(quote.depositAddress);
    const refunded = await Effect.runPromise(
      service.status(quote.depositAddress, session),
    );

    // #then
    expect({
      status: refunded.status,
      refunded: refunded.refundedAmount,
      balance: state.confidentialBalances.get(account),
    }).toEqual({
      status: "REFUNDED",
      refunded: quote.amountIn,
      balance: 50_000_000n + quote.amountIn,
    });
  });
});
