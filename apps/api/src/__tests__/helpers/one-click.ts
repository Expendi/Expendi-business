import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";

import type {
  OneClickFirmQuote,
  OneClickQuote,
  OneClickQuoteRequest,
  OneClickShape,
  OneClickSwapStatus,
} from "../../services/intents/one-click.js";
import {
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
  OneClickOutcomeUnknown,
  OneClickQuoteUntrusted,
  OneClickRefused,
} from "../../services/intents/one-click.js";

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
  let statusFailures = 0;

  const state = {
    /** Every quote request, dry or firm, in order. */
    quoteRequests,
    /** Firm quotes by deposit address. */
    quotes,
    /** Every deposit transaction 1Click was told about. */
    submitted,
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
    quote: (request) => {
      quoteRequests.push(request);
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

    status: (depositAddress) => {
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
      return Effect.succeed(statuses.get(depositAddress) ?? PENDING);
    },

    submitDeposit: (depositAddress, txHash) => {
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

    authenticate: () => Effect.dieMessage("authenticate is not faked"),
    balances: () => Effect.dieMessage("balances is not faked"),
    generateIntent: () => Effect.dieMessage("generateIntent is not faked"),
    submitIntent: () => Effect.dieMessage("submitIntent is not faked"),
  };

  return { layer: Layer.succeed(OneClick, service), state };
}
