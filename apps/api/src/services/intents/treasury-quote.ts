import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import { intentQuotes, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { ONE_CLICK_USDC_ASSET_IDS, OneClick } from "./one-click.js";
import {
  COMPANY_QUOTE_TTL_MS,
  maxQuoteCost,
  QuoteNotOpened,
  STABLECOIN_SLIPPAGE_BPS,
} from "./quote-deposit.js";

/**
 * The 1Click quote for one part of a move to Treasury
 * (docs/work/treasury/spec.md, section 4): `EXACT_INPUT` USDC on NEAR to USDC
 * on Base, so the part the company wallet sends is exactly the part the
 * ledger debits and the company pays what 1Click charges, with no fee cover
 * from Expendi. The recipient is the company's Treasury wallet and the
 * refund goes to its company wallet, both read from its `wallets` row and
 * never from a request.
 *
 * The way back (`openTreasuryReturnQuote`) is the mirror image: USDC on Base
 * to USDC on NEAR, paid by the Treasury wallet, recipient the company wallet
 * and refund to the Treasury wallet.
 */

const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const readWallet = (organizationId: string) =>
  withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(wallets)
        .where(eq(wallets.organizationId, organizationId))
        .limit(1),
    ),
  ).pipe(Effect.map(([wallet]) => wallet ?? null));

/** The two addresses a move to Treasury quotes between, or why there are none. */
function treasuryRoute(organizationId: string) {
  return Effect.gen(function* () {
    const wallet = yield* readWallet(organizationId);
    if (
      wallet?.status !== "active" ||
      wallet.chain !== "near" ||
      wallet.address === null ||
      !isImplicitNearAccount(wallet.address)
    ) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "no_wallet",
          message: "The company has no active company wallet on NEAR.",
        }),
      );
    }
    if (wallet.treasuryTurnedOnAt === null || wallet.treasuryAddress === null) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "no_wallet",
          message: "The company hasn't turned on Treasury.",
        }),
      );
    }
    return {
      wallet,
      companyAddress: wallet.address,
      treasuryAddress: wallet.treasuryAddress,
    };
  });
}

/**
 * `one_click_unavailable` is 1Click not answering, which may pass; a refusal
 * is a definite no that asking again won't change.
 */
const quoteFailure = (error: {
  readonly _tag: string;
  readonly message: string;
}) =>
  new QuoteNotOpened({
    reason:
      error._tag === "OneClickQuoteUntrusted"
        ? "untrusted"
        : error._tag === "OneClickOutcomeUnknown"
          ? "one_click_unavailable"
          : "one_click",
    message: error.message,
  });

/**
 * What 1Click would charge to move `amountIn` to the Treasury wallet and how
 * long it says it takes, from a dry quote: no deposit address exists and
 * nothing is saved.
 */
export function estimateTreasuryPart(input: {
  readonly organizationId: string;
  readonly amountIn: bigint;
}): Effect.Effect<
  { readonly costUsdc: bigint; readonly seconds: number },
  QuoteNotOpened | DatabaseError,
  OneClick | DatabaseService
> {
  return Effect.gen(function* () {
    const route = yield* treasuryRoute(input.organizationId);
    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote({
        dry: true,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        amount: input.amountIn,
        recipient: route.treasuryAddress,
        refundTo: route.companyAddress,
        deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
        slippageBps: STABLECOIN_SLIPPAGE_BPS,
      })
      .pipe(Effect.mapError(quoteFailure));
    const cost = quoted.amountIn - quoted.amountOut;
    if (cost < 0n || cost > maxQuoteCost(quoted.amountIn)) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "untrusted",
          message: `1Click asks ${cost} USDC base units to move ${quoted.amountIn}, which is more than a USDC route costs.`,
        }),
      );
    }
    return { costUsdc: cost, seconds: quoted.timeEstimateSeconds ?? 30 };
  });
}

/**
 * Takes a firm `EXACT_INPUT` quote for `amountIn` and saves it, linked to its
 * move. The same key returns the quote already saved under it and asks 1Click
 * nothing, so a part is quoted once however often the step runs.
 */
export function openTreasuryQuote(input: {
  readonly organizationId: string;
  readonly moveId: string;
  readonly quoteKey: string;
  readonly amountIn: bigint;
}): Effect.Effect<
  IntentQuote,
  QuoteNotOpened | DatabaseError,
  OneClick | DatabaseService
> {
  const { organizationId } = input;
  const byKey = withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            eq(intentQuotes.quoteKey, input.quoteKey),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([quote]) => quote ?? null));

  return Effect.gen(function* () {
    const existing = yield* byKey;
    if (existing) return existing;

    const { wallet, companyAddress, treasuryAddress } =
      yield* treasuryRoute(organizationId);
    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        amount: input.amountIn,
        recipient: treasuryAddress,
        refundTo: companyAddress,
        deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
        slippageBps: STABLECOIN_SLIPPAGE_BPS,
      })
      .pipe(Effect.mapError(quoteFailure));
    const untrusted = (message: string) =>
      Effect.fail(new QuoteNotOpened({ reason: "untrusted", message }));
    if (quoted.dry)
      return yield* untrusted("1Click answered with a dry quote.");
    // A plain ft_transfer carries no memo, and only a 64-hex account can be
    // registered and paid the way the deposit does.
    if (
      quoted.depositMemo !== null ||
      !isImplicitNearAccount(quoted.depositAddress)
    ) {
      return yield* untrusted(
        "1Click's deposit address can't be paid with a plain USDC transfer.",
      );
    }
    if (
      quoted.amountIn !== input.amountIn ||
      quoted.amountOut <= 0n ||
      quoted.amountOut > quoted.amountIn ||
      quoted.amountIn - quoted.amountOut > maxQuoteCost(quoted.amountIn)
    ) {
      return yield* untrusted(
        `1Click asks ${quoted.amountIn} to deliver ${quoted.amountOut} USDC base units, which is more than a USDC route costs.`,
      );
    }
    if (quoted.amountIn > wallet.perTransactionMaxUsdc) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "over_cap",
          message: `The part needs ${quoted.amountIn} USDC base units in one transfer, over the wallet's per-transaction maximum of ${wallet.perTransactionMaxUsdc}.`,
        }),
      );
    }

    const inserted = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .insert(intentQuotes)
          .values({
            organizationId,
            walletId: wallet.id,
            quoteKey: input.quoteKey,
            purpose: "to_treasury",
            swapType: "EXACT_INPUT",
            originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
            destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
            amountIn: quoted.amountIn,
            amountOut: quoted.amountOut,
            minAmountOut: quoted.minAmountOut,
            depositAddress: quoted.depositAddress,
            recipient: treasuryAddress,
            refundTo: companyAddress,
            deadline: quoted.deadline,
            quoteResponse: quoted.signedResponse,
            treasuryMoveId: input.moveId,
          })
          .onConflictDoNothing({
            target: [intentQuotes.organizationId, intentQuotes.quoteKey],
          })
          .returning(),
      ),
    ).pipe(Effect.map(([row]) => row ?? null));
    if (inserted) return inserted;
    const raced = yield* byKey;
    return raced ?? (yield* Effect.dieMessage("intent quote insert vanished"));
  });
}

/**
 * What 1Click would charge to send `amountIn` from the Treasury wallet back
 * to the company wallet and how long it says that takes: a dry quote, so no
 * deposit address exists and nothing is saved.
 */
export function estimateTreasuryReturnPart(input: {
  readonly organizationId: string;
  readonly amountIn: bigint;
}): Effect.Effect<
  { readonly costUsdc: bigint; readonly seconds: number },
  QuoteNotOpened | DatabaseError,
  OneClick | DatabaseService
> {
  return Effect.gen(function* () {
    const route = yield* treasuryRoute(input.organizationId);
    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote({
        dry: true,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        amount: input.amountIn,
        recipient: route.companyAddress,
        refundTo: route.treasuryAddress,
        deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
        slippageBps: STABLECOIN_SLIPPAGE_BPS,
      })
      .pipe(Effect.mapError(quoteFailure));
    const cost = quoted.amountIn - quoted.amountOut;
    if (cost < 0n || cost > maxQuoteCost(quoted.amountIn)) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "untrusted",
          message: `1Click asks ${cost} USDC base units to move ${quoted.amountIn}, which is more than a USDC route costs.`,
        }),
      );
    }
    return { costUsdc: cost, seconds: quoted.timeEstimateSeconds ?? 45 };
  });
}

/**
 * Takes a firm `EXACT_INPUT` quote to send `amountIn` from the Treasury
 * wallet to the company wallet and saves it, linked to its move. The same
 * key returns the quote already saved under it and asks 1Click nothing.
 * The Treasury wallet's policy caps one transfer, so a part over the
 * wallet's per-transaction maximum is refused here too.
 */
export function openTreasuryReturnQuote(input: {
  readonly organizationId: string;
  readonly moveId: string;
  readonly quoteKey: string;
  readonly amountIn: bigint;
}): Effect.Effect<
  IntentQuote,
  QuoteNotOpened | DatabaseError,
  OneClick | DatabaseService
> {
  const { organizationId } = input;
  const byKey = withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            eq(intentQuotes.quoteKey, input.quoteKey),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([quote]) => quote ?? null));

  return Effect.gen(function* () {
    const existing = yield* byKey;
    if (existing) return existing;

    const { wallet, companyAddress, treasuryAddress } =
      yield* treasuryRoute(organizationId);
    const untrusted = (message: string) =>
      Effect.fail(new QuoteNotOpened({ reason: "untrusted", message }));
    if (!BASE_ADDRESS.test(treasuryAddress)) {
      return yield* untrusted("The Treasury wallet isn't a Base address.");
    }
    if (input.amountIn > wallet.perTransactionMaxUsdc) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "over_cap",
          message: `The part needs ${input.amountIn} USDC base units in one transfer, over the Treasury wallet's per-transaction maximum of ${wallet.perTransactionMaxUsdc}.`,
        }),
      );
    }
    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        amount: input.amountIn,
        recipient: companyAddress,
        refundTo: treasuryAddress,
        deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
        slippageBps: STABLECOIN_SLIPPAGE_BPS,
      })
      .pipe(Effect.mapError(quoteFailure));
    if (quoted.dry)
      return yield* untrusted("1Click answered with a dry quote.");
    // The Treasury wallet pays an address on Base with a plain USDC transfer.
    if (
      quoted.depositMemo !== null ||
      !BASE_ADDRESS.test(quoted.depositAddress) ||
      quoted.depositAddress.toLowerCase() === treasuryAddress.toLowerCase()
    ) {
      return yield* untrusted(
        "1Click's deposit address can't be paid with a plain USDC transfer.",
      );
    }
    if (
      quoted.amountIn !== input.amountIn ||
      quoted.amountOut <= 0n ||
      quoted.amountOut > quoted.amountIn ||
      quoted.amountIn - quoted.amountOut > maxQuoteCost(quoted.amountIn)
    ) {
      return yield* untrusted(
        `1Click asks ${quoted.amountIn} to deliver ${quoted.amountOut} USDC base units, which is more than a USDC route costs.`,
      );
    }

    const inserted = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .insert(intentQuotes)
          .values({
            organizationId,
            walletId: wallet.id,
            quoteKey: input.quoteKey,
            purpose: "from_treasury",
            swapType: "EXACT_INPUT",
            originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
            destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
            amountIn: quoted.amountIn,
            amountOut: quoted.amountOut,
            minAmountOut: quoted.minAmountOut,
            depositAddress: quoted.depositAddress,
            recipient: companyAddress,
            refundTo: treasuryAddress,
            deadline: quoted.deadline,
            quoteResponse: quoted.signedResponse,
            treasuryMoveId: input.moveId,
          })
          .onConflictDoNothing({
            target: [intentQuotes.organizationId, intentQuotes.quoteKey],
          })
          .returning(),
      ),
    ).pipe(Effect.map(([row]) => row ?? null));
    if (inserted) return inserted;
    const raced = yield* byKey;
    return raced ?? (yield* Effect.dieMessage("intent quote insert vanished"));
  });
}
