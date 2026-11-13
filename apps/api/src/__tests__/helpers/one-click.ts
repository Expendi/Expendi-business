import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer, Redacted } from "effect";

import type { CompanyIntentRefusalReason } from "../../services/intents/confidential-account.js";
import type {
  OneClickFirmQuote,
  OneClickQuote,
  OneClickQuoteRequest,
  OneClickSession,
  OneClickShape,
  OneClickSignedIntent,
  OneClickSwapStatus,
  OneClickUnsignedIntent,
} from "../../services/intents/one-click.js";
import {
  CONFIDENTIAL_INTENTS_CONTRACT_ID,
  confidentialUsdcTokenId,
  versionedNonce,
} from "../../services/intents/confidential-account.js";
import {
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
  OneClickOutcomeUnknown,
  OneClickQuoteUntrusted,
  OneClickRefused,
} from "../../services/intents/one-click.js";
import { TEST_USDC_CONTRACT } from "./near.js";

/**
 * What 1Click does with the next quote request:
 * - `refused`: it answers 400 and creates nothing;
 * - `unknown`: its answer is lost, so whether it made a quote isn't known;
 * - `untrusted`: it answers with a quote that fails the signature check.
 */
type QuoteFailure = "refused" | "unknown" | "untrusted";

export interface FakeOneClickQuote {
  readonly request: OneClickQuoteRequest;
  readonly quote: OneClickFirmQuote;
}

/**
 * How the next message the fake generates is wrong, each caught by
 * `checkCompanyIntent` under the reason of the same name.
 */
export type BadIntent = Extract<
  CompanyIntentRefusalReason,
  "recipient" | "signer" | "receiver" | "token_id" | "amount_not_the_quote"
>;

/** What 1Click does with the next submitted intent. */
type SubmitFailure = "refused" | "unknown";

/** One signed intent the fake was handed, and what it did with it. */
export interface FakeSubmittedIntent {
  readonly depositAddress: string;
  readonly signed: OneClickSignedIntent;
  readonly outcome: "accepted" | SubmitFailure;
}

/** One call that carries, or should carry, a company's session. */
export interface FakeOneClickCall {
  readonly call:
    | "quote"
    | "status"
    | "submitDeposit"
    | "balances"
    | "generateIntent"
    | "submitIntent";
  /** Absent for `quote` of a dry request and for `balances`. */
  readonly depositAddress?: string;
  /** What the call was sent with; undefined when no session was sent. */
  readonly session: OneClickSession | undefined;
}

const SESSION_LIFETIME_MS = 15 * 60_000;

/** 1Click's messages expire three days out. */
const INTENT_LIFETIME_MS = 3 * 24 * 60 * 60_000;

/** Whether 1Click would only deal with this request through a company's session. */
const touchesConfidential = (request: OneClickQuoteRequest): boolean =>
  request.recipientType === "CONFIDENTIAL_INTENTS" ||
  request.depositType === "CONFIDENTIAL_INTENTS" ||
  request.refundType === "CONFIDENTIAL_INTENTS";

const unauthorized = (what: string) =>
  Effect.fail(
    new OneClickRefused({
      message: `1Click refused ${what}: unauthorized`,
      httpStatus: 401,
    }),
  );

const PENDING: OneClickSwapStatus = {
  status: "PENDING_DEPOSIT",
  updatedAt: null,
  depositedAmount: null,
  amountIn: null,
  amountOut: null,
  refundedAmount: null,
  refundReason: null,
  nearTxHashes: [],
  originChainTxHashes: [],
  destinationChainTxHashes: [],
};

/**
 * The message 1Click generates to pay a quote's deposit address out of the
 * account: one `transfer` of the confidential USDC token for exactly the
 * quote's amount in, addressed to `intents.far`, expiring three days out.
 */
function generatedMessage(
  quote: OneClickFirmQuote,
  signerId: string,
  bad?: BadIntent,
): OneClickUnsignedIntent {
  const start = new Date();
  const deadline = new Date(start.getTime() + INTENT_LIFETIME_MS);
  const message = JSON.stringify({
    deadline: deadline.toISOString(),
    intents: [
      {
        intent: "transfer",
        receiver_id:
          bad === "receiver"
            ? randomBytes(32).toString("hex")
            : quote.depositAddress,
        tokens: {
          [bad === "token_id"
            ? `nep141:${TEST_USDC_CONTRACT}`
            : confidentialUsdcTokenId(TEST_USDC_CONTRACT)]: (
            quote.amountIn + (bad === "amount_not_the_quote" ? 1n : 0n)
          ).toString(),
        },
      },
    ],
    signer_id: bad === "signer" ? randomBytes(32).toString("hex") : signerId,
  });
  return {
    message,
    nonce: Buffer.from(
      versionedNonce({
        salt: randomBytes(4),
        deadline,
        start,
        random: randomBytes(7),
      }),
    ).toString("base64"),
    recipient:
      bad === "recipient" ? "intents.near" : CONFIDENTIAL_INTENTS_CONTRACT_ID,
  };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Amounts as 1Click's JSON carries them: decimal strings, so the response can be saved. */
const asReceived = (
  amounts: Readonly<Record<string, bigint>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(amounts).map(([name, value]) => [name, value.toString()]),
  );

/**
 * 1Click in memory. It prices a quote the way the real one does (a flat
 * cost, and for `EXACT_OUTPUT` a slippage buffer on top of the least it
 * needs), gives each firm quote its own deposit address on the origin
 * chain, and reports whatever status a test sets. It never moves money:
 * a test that needs a delivery or a refund makes the transfer itself.
 */
export function makeFakeOneClick() {
  const quoteRequests: OneClickQuoteRequest[] = [];
  const quotes = new Map<string, FakeOneClickQuote>();
  const statuses = new Map<string, OneClickSwapStatus>();
  const submitted: { depositAddress: string; txHash: string }[] = [];
  const quoteFailures: QuoteFailure[] = [];
  const calls: FakeOneClickCall[] = [];
  const sessions = new Map<string, string>();
  const signIns: string[] = [];
  const confidentialBalances = new Map<string, bigint>();
  const submittedIntents: FakeSubmittedIntent[] = [];
  const acceptedIntents = new Map<string, string>();
  const generateFailures: number[] = [];
  const submitFailures: SubmitFailure[] = [];
  const badIntents: BadIntent[] = [];
  let statusFailures = 0;

  const signerOf = (session: OneClickSession | undefined) =>
    session === undefined ? undefined : sessions.get(Redacted.value(session));

  /**
   * The account whose session 1Click reports a quote to: the confidential
   * recipient, or the account that pays it out of a confidential account.
   */
  const ownerOf = (request: OneClickQuoteRequest): string =>
    request.depositType === "CONFIDENTIAL_INTENTS"
      ? request.refundTo
      : request.recipient;

  const state = {
    /** Every quote request, dry or firm, in order. */
    quoteRequests,
    /** Firm quotes by deposit address. */
    quotes,
    /** Every deposit transaction 1Click was told about. */
    submitted,
    /** Every call that may carry a session, with the session it carried. */
    calls,
    /** The account of each sign-in, in order; a second one ends no earlier session. */
    signIns,
    /** What each account holds in its confidential account, in USDC base units. */
    confidentialBalances,
    /** Credits a confidential account, as a delivery to it would. */
    fundConfidential(account: string, amount: bigint) {
      confidentialBalances.set(
        account,
        (confidentialBalances.get(account) ?? 0n) + amount,
      );
    },
    /**
     * 1Click delivers a quote's output to the confidential account it was
     * quoted for: reports `SUCCESS` with `amountOut`, and the balance rises
     * by it.
     */
    deliverConfidential(depositAddress: string, amountOut: bigint) {
      const known = quotes.get(depositAddress);
      if (known === undefined) {
        throw new Error(`no fake 1Click quote for ${depositAddress}`);
      }
      state.setStatus(depositAddress, {
        status: "SUCCESS",
        depositedAmount: known.quote.amountIn,
        amountIn: known.quote.amountIn,
        amountOut,
      });
      state.fundConfidential(known.request.recipient, amountOut);
    },
    /**
     * Every intent submitted, with the outcome, in order. A repeat of
     * accepted bytes is listed again but moves no more USDC: a nonce runs once.
     */
    submittedIntents,
    /** The next `times` generated messages fail as 1Click would on an error. */
    failNextGenerate(times = 1) {
      generateFailures.push(times);
    },
    /** Queue what happens to the next submitted intents; each without one is accepted. */
    failNextSubmit(...failures: SubmitFailure[]) {
      submitFailures.push(...failures);
    },
    /** The next generated message is wrong in the way named. */
    badNextIntent(reason: BadIntent) {
      badIntents.push(reason);
    },
    /**
     * 1Click delivers an intent-paid quote to its payee: reports `SUCCESS`
     * with what the swap took in (the whole amount in unless given) and
     * what the payee received (`amountOut`). Nothing returns to the account
     * until `returnUnused`.
     */
    deliverIntentPayout(
      depositAddress: string,
      taken?: { readonly swappedAmountIn?: bigint },
    ) {
      const known = quotes.get(depositAddress);
      if (known === undefined) {
        throw new Error(`no fake 1Click quote for ${depositAddress}`);
      }
      state.setStatus(depositAddress, {
        status: "SUCCESS",
        depositedAmount: known.quote.amountIn,
        amountIn: taken?.swappedAmountIn ?? known.quote.amountIn,
        amountOut: known.quote.amountOut,
      });
    },
    /**
     * An exact-amount-out quote's unused part coming back to the account that
     * paid it, as it does about a minute after `SUCCESS`: not reported as a
     * refund. Returns how much came back.
     */
    returnUnused(depositAddress: string): bigint {
      const known = quotes.get(depositAddress);
      const reported = statuses.get(depositAddress);
      if (known === undefined || reported?.amountIn == null) {
        throw new Error(`no delivered fake 1Click quote for ${depositAddress}`);
      }
      const unused = known.quote.amountIn - reported.amountIn;
      if (unused > 0n) state.fundConfidential(known.request.refundTo, unused);
      return unused;
    },
    /**
     * 1Click refunds an intent-paid quote: reports `REFUNDED` and the whole
     * amount in is back in the account.
     */
    refundIntentPayout(depositAddress: string) {
      const known = quotes.get(depositAddress);
      if (known === undefined) {
        throw new Error(`no fake 1Click quote for ${depositAddress}`);
      }
      state.setStatus(depositAddress, {
        status: "REFUNDED",
        depositedAmount: known.quote.amountIn,
        refundedAmount: known.quote.amountIn,
        refundReason: "PARTIAL_DEPOSIT",
      });
      state.fundConfidential(known.request.refundTo, known.quote.amountIn);
    },
    /** What a move costs, in the origin asset's smallest unit. */
    costPerQuote: 4_465n,
    /** Queue what happens to the next quote requests; each without one succeeds. */
    failNextQuotes(...failures: QuoteFailure[]) {
      quoteFailures.push(...failures);
    },
    /** Forgets quote outcomes queued but not yet used. */
    clearQuoteFailures() {
      quoteFailures.length = 0;
    },
    /** The next `times` status calls get no answer. */
    failNextStatus(times = 1) {
      statusFailures = times;
    },
    /** What 1Click reports for a deposit address from now on. */
    setStatus(depositAddress: string, status: Partial<OneClickSwapStatus>) {
      statuses.set(depositAddress, {
        ...(statuses.get(depositAddress) ?? PENDING),
        updatedAt: new Date(),
        ...status,
      });
    },
  };

  function price(request: OneClickQuoteRequest) {
    const slippage = (value: bigint) =>
      ceilDiv(value * BigInt(request.slippageBps), 10_000n);
    if (request.swapType === "EXACT_OUTPUT") {
      const minAmountIn = request.amount + state.costPerQuote;
      return {
        amountIn: minAmountIn + slippage(minAmountIn),
        minAmountIn,
        amountOut: request.amount,
        minAmountOut: request.amount,
      };
    }
    const amountOut = request.amount - state.costPerQuote;
    return {
      amountIn: request.amount,
      minAmountIn: request.amount,
      amountOut,
      minAmountOut: amountOut - slippage(amountOut),
    };
  }

  /**
   * A fresh address on the origin asset's chain (Base, or else NEAR), or an
   * account inside NEAR Intents for a deposit paid from there.
   */
  const depositAddressFor = (request: OneClickQuoteRequest): string =>
    request.depositType !== "INTENTS" &&
    request.originAsset === ONE_CLICK_USDC_ASSET_IDS.base
      ? `0x${randomBytes(20).toString("hex")}`
      : randomBytes(32).toString("hex");

  const service: OneClickShape = {
    quote: (request, session) => {
      quoteRequests.push(request);
      calls.push({ call: "quote", session });
      if (touchesConfidential(request) && signerOf(session) === undefined) {
        return unauthorized("quote");
      }
      if (
        request.depositType === "CONFIDENTIAL_INTENTS" &&
        signerOf(session) !== request.refundTo
      ) {
        return unauthorized("quote");
      }
      const failure = quoteFailures.shift();
      if (failure === "refused") {
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused quote: fake refusal",
            httpStatus: 400,
          }),
        );
      }
      if (failure === "unknown") {
        return Effect.fail(
          new OneClickOutcomeUnknown({ message: "fake 1Click lost reply" }),
        );
      }
      if (failure === "untrusted") {
        return Effect.fail(
          new OneClickQuoteUntrusted({
            reason: "bad_signature",
            message: "The quote isn't signed by 1Click",
          }),
        );
      }
      const amounts = price(request);
      if (amounts.amountOut <= 0n) {
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused quote: amount is too low",
            httpStatus: 400,
          }),
        );
      }
      const shared = {
        ...amounts,
        swapType: request.swapType,
        timeEstimateSeconds: 22,
        correlationId: randomUUID(),
      };
      if (request.dry) {
        const dry: OneClickQuote = {
          ...shared,
          dry: true,
          signedResponse: { fake: true, quote: asReceived(amounts) },
        };
        return Effect.succeed(dry);
      }
      const depositAddress = depositAddressFor(request);
      const quote: OneClickFirmQuote = {
        ...shared,
        dry: false,
        depositAddress,
        depositMemo: null,
        deadline: request.deadline,
        timeWhenInactive: request.deadline,
        signedResponse: {
          fake: true,
          quote: { ...asReceived(amounts), depositAddress },
        },
      };
      quotes.set(depositAddress, { request, quote });
      return Effect.succeed(quote);
    },

    status: (depositAddress, session) => {
      calls.push({ call: "status", depositAddress, session });
      if (statusFailures > 0) {
        statusFailures -= 1;
        return Effect.fail(
          new OneClickOutcomeUnknown({ message: "fake 1Click status failure" }),
        );
      }
      if (!quotes.has(depositAddress)) {
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused status: deposit address not found",
            httpStatus: 404,
          }),
        );
      }
      const known = quotes.get(depositAddress);
      if (
        known !== undefined &&
        touchesConfidential(known.request) &&
        signerOf(session) !== ownerOf(known.request)
      ) {
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused status: deposit address not found",
            httpStatus: 404,
          }),
        );
      }
      return Effect.succeed(statuses.get(depositAddress) ?? PENDING);
    },

    submitDeposit: (depositAddress, txHash, session) => {
      calls.push({ call: "submitDeposit", depositAddress, session });
      if (!quotes.has(depositAddress)) {
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused deposit submit: deposit address not found",
            httpStatus: 404,
          }),
        );
      }
      submitted.push({ depositAddress, txHash });
      return Effect.void;
    },

    authenticate: (signed) =>
      Effect.sync(() => {
        const { signer_id: signerId } = JSON.parse(signed.payload.message) as {
          signer_id: string;
        };
        const token = `fake-session-${sessions.size + 1}`;
        sessions.set(token, signerId);
        signIns.push(signerId);
        return {
          session: Redacted.make(token),
          expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
        };
      }),
    balances: (session) => {
      calls.push({ call: "balances", session });
      const account = signerOf(session);
      if (account === undefined) return unauthorized("balances");
      return Effect.succeed([
        {
          tokenId: `nep141:${TEST_USDC_CONTRACT}`,
          available: confidentialBalances.get(account) ?? 0n,
        },
      ]);
    },
    generateIntent: ({ depositAddress, signerId }, session) => {
      calls.push({ call: "generateIntent", depositAddress, session });
      const known = quotes.get(depositAddress);
      if (
        known?.request.depositType !== "CONFIDENTIAL_INTENTS" ||
        signerOf(session) !== signerId ||
        known.request.refundTo !== signerId
      ) {
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused intent: deposit address not found",
            httpStatus: 404,
          }),
        );
      }
      const failures = generateFailures[0];
      if (failures !== undefined) {
        if (failures <= 1) generateFailures.shift();
        else generateFailures[0] = failures - 1;
        return Effect.fail(
          new OneClickOutcomeUnknown({ message: "fake 1Click lost reply" }),
        );
      }
      return Effect.sync(() =>
        generatedMessage(known.quote, signerId, badIntents.shift()),
      );
    },

    submitIntent: (signed, session) => {
      const { signer_id: signerId, intents } = JSON.parse(
        signed.payload.message,
      ) as {
        signer_id: string;
        intents: { receiver_id: string; tokens: Record<string, string> }[];
      };
      const [intent] = intents;
      const depositAddress = intent?.receiver_id ?? "";
      calls.push({ call: "submitIntent", depositAddress, session });
      const record = (outcome: FakeSubmittedIntent["outcome"]) => {
        submittedIntents.push({ depositAddress, signed, outcome });
      };
      const failure = submitFailures.shift();
      if (failure !== undefined) {
        record(failure);
        return Effect.fail(
          failure === "refused"
            ? new OneClickRefused({
                message: "1Click refused intent submit: fake refusal",
                httpStatus: 400,
              })
            : new OneClickOutcomeUnknown({ message: "fake 1Click lost reply" }),
        );
      }
      const known = quotes.get(depositAddress);
      const amount = BigInt(Object.values(intent?.tokens ?? {})[0] ?? "0");
      if (
        known === undefined ||
        signerOf(session) !== signerId ||
        known.request.refundTo !== signerId
      ) {
        record("refused");
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused intent submit: unauthorized",
            httpStatus: 401,
          }),
        );
      }
      const hash = acceptedIntents.get(signed.payload.nonce);
      if (hash !== undefined) {
        record("accepted");
        return Effect.succeed({ intentHash: hash });
      }
      if ((confidentialBalances.get(signerId) ?? 0n) < amount) {
        record("refused");
        return Effect.fail(
          new OneClickRefused({
            message: "1Click refused intent submit: insufficient balance",
            httpStatus: 400,
          }),
        );
      }
      confidentialBalances.set(
        signerId,
        (confidentialBalances.get(signerId) ?? 0n) - amount,
      );
      const intentHash = randomBytes(32).toString("hex");
      acceptedIntents.set(signed.payload.nonce, intentHash);
      record("accepted");
      return Effect.succeed({ intentHash });
    },
  };

  return { layer: Layer.succeed(OneClick, service), service, state };
}
