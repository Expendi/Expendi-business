/**
 * Finds out whether a company's money can sit in a confidential account in
 * NEAR Intents instead of its public company wallet, against the real chain,
 * Privy and the 1Click API, for one existing company
 * (scripts/create-test-company.ts makes one).
 *
 * --step check     Moves nothing. Signs the company in to 1Click, reads its
 *                  confidential balances and history, and takes dry quotes:
 *                  a Base hop at each confidentiality level, and each leg
 *                  the other steps use.
 * --step intent    Moves nothing. Takes a real quote for each kind of payment
 *                  out of the confidential account and prints the message
 *                  1Click would have the company wallet sign, unsigned.
 * --step move-in   The gas relayer pays --usdc to a 1Click deposit address
 *                  that delivers into the company's confidential account.
 * --step pay       The company wallet signs an intent that pays --pay from
 *                  its confidential account to --base-recipient on Base.
 * --step move-out  The company wallet signs an intent that sends whatever
 *                  USDC is left in its confidential account to the relayer.
 *
 * The three money steps move real USDC on mainnet, and all of it is the gas
 * relayer's: the company wallet only ever signs messages here, so no
 * company's ledger changes and nothing arrives for the deposit watcher to
 * credit. Refunds go to the relayer or stay in the confidential account.
 *
 * Each money step saves its deposit address under --run before anything is
 * paid or signed, so running it again with the same --run resumes that quote
 * rather than paying twice.
 *
 * The spend cap doesn't apply here, because the company wallet spends
 * nothing of its own. A production signer of intents must enforce it.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/spike-confidential-intents.ts \
 *        --organization-id <id> --step check
 */
import "../src/secrets/bootstrap.js";

import type { OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { eq } from "drizzle-orm";
import { Config, Effect, Option, Redacted } from "effect";
import { baseEncode } from "near-api-js";
import { z } from "zod";

import { wallets } from "../src/db/schema/index.js";
import { query, withScope } from "../src/db/scope.js";
import { makeRuntime } from "../src/runtime.js";
import { NearRelayer } from "../src/services/chain/near-relayer.js";
import { NearRpc } from "../src/services/chain/near-rpc.js";
import { NearChain } from "../src/services/chain/near.js";
import {
  ONE_CLICK_DEFAULT_BASE_URL,
  ONE_CLICK_QUOTE_SIGNER_PUBLIC_KEY,
  ONE_CLICK_USDC_ASSET_IDS,
} from "../src/services/intents/one-click.js";
import { PrivyWallets } from "../src/services/wallet/privy-wallets.js";

const STEPS = ["check", "intent", "move-in", "pay", "move-out"] as const;
const CONFIDENTIALITY_LEVELS = ["public", "basic", "advanced"] as const;
const SETTLED = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const MAX_SPIKE_USDC = 5_000_000n;
const POLL_MS = 3_000;
const MAX_POLLS = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const SIGN_IN_TTL_MS = 5 * 60_000;
const QUOTE_TTL_MS = 30 * 60_000;

const { values } = parseArgs({
  options: {
    "organization-id": { type: "string" },
    step: { type: "string" },
    run: { type: "string", default: "1" },
    usdc: { type: "string", default: "1" },
    pay: { type: "string", default: "0.3" },
    "base-recipient": { type: "string" },
  },
});

const organizationId = values["organization-id"];
const step = STEPS.find((name) => name === values.step);
const run = values.run;
if (!organizationId || !step || !/^[a-z0-9-]+$/.test(run)) {
  throw new Error(
    `Pass --organization-id <id> and --step <${STEPS.join("|")}> [--run <label>]`,
  );
}

const toBaseUnits = (usdc: string): bigint => {
  if (!/^\d+(\.\d{1,6})?$/.test(usdc)) {
    throw new Error(`Not a USDC amount: ${usdc}`);
  }
  const [whole = "0", fraction = ""] = usdc.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const toUsdc = (units: bigint): string =>
  `${(units / 1_000_000n).toString()}.${(units % 1_000_000n).toString().padStart(6, "0")}`;

const spikeAmount = (usdc: string): bigint => {
  const amount = toBaseUnits(usdc);
  if (amount <= 0n || amount > MAX_SPIKE_USDC) {
    throw new Error(
      `A spike amount must be above 0 and at most ${toUsdc(MAX_SPIKE_USDC)} USDC`,
    );
  }
  return amount;
};

type AccountType =
  "ORIGIN_CHAIN" | "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";

interface QuoteInput {
  readonly dry: boolean;
  readonly swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly amount: bigint;
  readonly slippageBps: number;
  readonly depositType: AccountType;
  readonly recipientType: AccountType;
  readonly refundType: AccountType;
  readonly recipient: string;
  readonly refundTo: string;
  readonly confidentiality?: (typeof CONFIDENTIALITY_LEVELS)[number];
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const amountString = z.string().regex(/^\d{1,39}$/);

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number(),
  refreshExpiresIn: z.number(),
});

const quoteSchema = z.object({
  quote: z.object({
    amountIn: amountString,
    amountOut: amountString,
    timeEstimate: z.number().nullish(),
    depositAddress: z.string().min(1).nullish(),
  }),
});

const nep413PayloadSchema = z.object({
  message: z.string().min(1),
  nonce: z.string().min(1),
  recipient: z.string().min(1),
  callbackUrl: z.string().optional(),
});
type Nep413Payload = z.infer<typeof nep413PayloadSchema>;

const generatedIntentSchema = z.object({
  intent: z.object({
    standard: z.literal("nep413"),
    payload: nep413PayloadSchema,
  }),
});

const statusSchema = z.object({
  status: z.string(),
  swapDetails: z.unknown().optional(),
});

const balancesSchema = z.object({
  balances: z.array(
    z.object({
      tokenId: z.string(),
      available: amountString,
      source: z.string(),
    }),
  ),
});

const viewResultSchema = z.object({
  result: z.object({ result: z.array(z.number()) }),
});

const stateSchema = z.record(
  z.string(),
  z.object({
    depositAddress: z.string(),
    depositTxHash: z.string().optional(),
    submitted: z.boolean().optional(),
  }),
);
type SpikeState = z.infer<typeof stateSchema>;

const statePath = join(
  tmpdir(),
  `expendi-spike-confidential-${organizationId}-${run}.json`,
);
const readState = (): SpikeState =>
  existsSync(statePath)
    ? stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")))
    : {};
const saveState = (
  name: (typeof STEPS)[number],
  entry: SpikeState[string],
): void => {
  writeFileSync(
    statePath,
    JSON.stringify({ ...readState(), [name]: entry }, null, 2),
  );
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const brief = (body: unknown): string =>
  (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 400);

/**
 * The 32-byte nonce 1Click accepts on a sign-in, laid out as the Intents SDK
 * builds it (sdk-monorepo, packages/intents-sdk/src/intents/expirable-nonce.ts):
 * magic prefix, version, the contract's salt, the deadline, then the start
 * time and 7 random bytes. Times are nanoseconds, little-endian.
 */
const versionedNonce = (salt: Buffer, deadline: Date, start: Date): Buffer => {
  if (salt.length !== 4) throw new Error("The contract salt must be 4 bytes");
  const nonce = Buffer.alloc(32);
  nonce.set([0x56, 0x28, 0xf6, 0xc6], 0);
  nonce.writeUInt8(0, 4);
  nonce.set(salt, 5);
  nonce.writeBigUInt64LE(BigInt(deadline.getTime()) * 1_000_000n, 9);
  nonce.writeBigUInt64LE(BigInt(start.getTime()) * 1_000_000n, 17);
  nonce.set(randomBytes(7), 25);
  return nonce;
};

const runtime = makeRuntime();
try {
  const { relayer, rpc, privy, chain, rpcUrl, baseUrl, apiKey, wallet } =
    await runtime.runPromise(
      Effect.gen(function* () {
        const [row] = yield* withScope({ organizationId }, (tx) =>
          query(() =>
            tx
              .select()
              .from(wallets)
              .where(eq(wallets.organizationId, organizationId)),
          ),
        );
        return {
          relayer: yield* NearRelayer,
          rpc: yield* NearRpc,
          privy: yield* PrivyWallets,
          chain: yield* NearChain,
          rpcUrl: yield* Config.redacted("NEAR_RPC_URL"),
          baseUrl: yield* Config.withDefault(
            Config.string("ONECLICK_BASE_URL"),
            ONE_CLICK_DEFAULT_BASE_URL,
          ),
          apiKey: yield* Config.option(Config.redacted("ONECLICK_API_KEY")),
          wallet: row,
        };
      }),
    );
  if (
    !wallet?.address ||
    !wallet.privyWalletId ||
    wallet.chain !== "near" ||
    wallet.status !== "active"
  ) {
    throw new Error("The company has no active NEAR company wallet");
  }
  if (chain.network !== "mainnet") {
    throw new Error("NEAR Intents is on mainnet only");
  }
  const companyAccount = wallet.address;
  const signer = privy.nearSigner({
    privyWalletId: wallet.privyWalletId,
    accountId: companyAccount,
  });
  const nearUsdc = ONE_CLICK_USDC_ASSET_IDS.near;
  const hasPartnerKey = Option.isSome(apiKey);

  const oneClick = async (
    method: "GET" | "POST",
    path: string,
    options: { readonly body?: unknown; readonly session?: string } = {},
  ): Promise<Reply> => {
    // Outside the account endpoints, 1Click reads a Bearer token as the
    // partner's unless X-API-Key carries that, and answers "Invalid token"
    // to the company's own (seen 2026-11-13).
    const sendSession =
      options.session !== undefined &&
      (hasPartnerKey || path.startsWith("/v0/account/"));
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(Option.isSome(apiKey)
          ? { "X-API-Key": Redacted.value(apiKey.value) }
          : {}),
        ...(sendSession
          ? { Authorization: `Bearer ${String(options.session)}` }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: parseJson(await response.text()) };
  };

  const accepted = (what: string, reply: Reply): unknown => {
    if (reply.status >= 300) {
      throw new Error(
        `1Click ${what} answered ${String(reply.status)}: ${brief(reply.body)}`,
      );
    }
    return reply.body;
  };

  const viewIntents = async (
    methodName: string,
    args: Record<string, string>,
  ): Promise<unknown> => {
    const response = await fetch(Redacted.value(rpcUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "spike",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: chain.intentsContractId,
          method_name: methodName,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = parseJson(await response.text());
    const parsed = viewResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`View ${methodName} failed: ${brief(body)}`);
    }
    return parseJson(Buffer.from(parsed.data.result.result).toString("utf8"));
  };

  const sign = async (payload: Nep413Payload) => {
    const signed = await signer.signNep413Message(companyAccount, {
      message: payload.message,
      recipient: payload.recipient,
      nonce: Buffer.from(payload.nonce, "base64"),
      callbackUrl: payload.callbackUrl,
    });
    return {
      standard: "nep413",
      payload,
      public_key: signed.publicKey.toString(),
      signature: `ed25519:${baseEncode(signed.signature)}`,
    };
  };

  const signIn = async () => {
    const salt = z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .safeParse(await viewIntents("current_salt", {}));
    if (!salt.success) {
      throw new Error("intents.near gave a salt that isn't 4 bytes of hex");
    }
    const start = new Date();
    const deadline = new Date(start.getTime() + SIGN_IN_TTL_MS);
    const signedData = await sign({
      message: JSON.stringify({
        deadline: deadline.toISOString(),
        intents: [],
        signer_id: companyAccount,
      }),
      nonce: versionedNonce(
        Buffer.from(salt.data, "hex"),
        deadline,
        start,
      ).toString("base64"),
      recipient: chain.intentsContractId,
    });
    const session = sessionSchema.parse(
      accepted(
        "sign-in",
        await oneClick("POST", "/v0/auth/authenticate", {
          body: { signedData },
        }),
      ),
    );
    console.log("Signed in to 1Click", {
      accessTokenMinutes: Math.round(session.expiresIn / 60),
      refreshTokenDays: Math.round(session.refreshExpiresIn / 86_400),
    });
    return session.accessToken;
  };

  const requestQuote = (session: string, input: QuoteInput): Promise<Reply> =>
    oneClick("POST", "/v0/quote", {
      session,
      body: {
        dry: input.dry,
        swapType: input.swapType ?? "EXACT_INPUT",
        slippageTolerance: input.slippageBps,
        originAsset: input.originAsset,
        depositType: input.depositType,
        destinationAsset: input.destinationAsset,
        amount: input.amount.toString(),
        refundTo: input.refundTo,
        refundType: input.refundType,
        recipient: input.recipient,
        recipientType: input.recipientType,
        deadline: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
        ...(input.confidentiality === undefined
          ? {}
          : { confidentiality: input.confidentiality }),
      },
    });

  const firmQuote = async (session: string, input: QuoteInput) => {
    const body = accepted("quote", await requestQuote(session, input));
    const { quote } = quoteSchema.parse(body);
    if (!quote.depositAddress) {
      throw new Error(`The quote has no deposit address: ${brief(body)}`);
    }
    return { body, quote, depositAddress: quote.depositAddress };
  };

  const dryQuote = async (
    label: string,
    session: string,
    input: Omit<QuoteInput, "dry">,
  ) => {
    const reply = await requestQuote(session, { ...input, dry: true });
    const parsed = quoteSchema.safeParse(reply.body);
    console.log(
      `  ${label}:`,
      reply.status < 300 && parsed.success
        ? {
            amountIn: toUsdc(BigInt(parsed.data.quote.amountIn)),
            amountOut: toUsdc(BigInt(parsed.data.quote.amountOut)),
            seconds: parsed.data.quote.timeEstimate ?? null,
          }
        : `${String(reply.status)} ${brief(reply.body)}`,
    );
  };

  const settle = async (session: string, depositAddress: string) => {
    const started = Date.now();
    let last = "";
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      const reply = await oneClick(
        "GET",
        `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
        { session },
      );
      const parsed = statusSchema.safeParse(reply.body);
      const status = parsed.success
        ? parsed.data.status
        : `${String(reply.status)} ${brief(reply.body)}`;
      const seconds = Math.round((Date.now() - started) / 1000);
      if (status !== last) {
        console.log(`  ${String(seconds)}s  ${status}`);
        last = status;
      }
      if (parsed.success && SETTLED.has(parsed.data.status)) {
        console.log("  Settled", {
          status: parsed.data.status,
          seconds,
          swapDetails: parsed.data.swapDetails,
        });
        return parsed.data.status;
      }
      await sleep(POLL_MS);
    }
    throw new Error(`The quote at ${depositAddress} did not settle in time`);
  };

  const confidentialBalances = async (session: string) => {
    const reply = await oneClick("GET", "/v0/account/balances", { session });
    return balancesSchema.parse(accepted("balances", reply)).balances;
  };

  const showBalances = async (label: string, session: string) => {
    const [companyWalletUsdc, [publicIntentsUsdc = 0n], confidential] =
      await Promise.all([
        runtime.runPromise(rpc.usdcBalance(companyAccount)),
        runtime.runPromise(rpc.intentsBalances(companyAccount, [nearUsdc])),
        confidentialBalances(session),
      ]);
    console.log(label, {
      companyWalletUsdc: toUsdc(companyWalletUsdc),
      publicIntentsUsdc: toUsdc(publicIntentsUsdc),
      confidential,
    });
  };

  const payFromConfidentialAccount = async (
    name: "pay" | "move-out",
    session: string,
    input: Pick<
      QuoteInput,
      | "destinationAsset"
      | "amount"
      | "slippageBps"
      | "recipient"
      | "recipientType"
    >,
  ) => {
    let entry = readState()[name];
    if (!entry) {
      const { quote, depositAddress } = await firmQuote(session, {
        ...input,
        dry: false,
        originAsset: nearUsdc,
        depositType: "CONFIDENTIAL_INTENTS",
        refundType: "CONFIDENTIAL_INTENTS",
        refundTo: companyAccount,
      });
      console.log("Quote", {
        amountIn: toUsdc(BigInt(quote.amountIn)),
        amountOut: toUsdc(BigInt(quote.amountOut)),
        depositAddress,
      });
      entry = { depositAddress };
      saveState(name, entry);
    }
    if (!entry.submitted) {
      const generated = generatedIntentSchema.parse(
        accepted(
          "generate-intent",
          await oneClick("POST", "/v0/generate-intent", {
            session,
            body: {
              type: "swap_transfer",
              standard: "nep413",
              signerId: companyAccount,
              depositAddress: entry.depositAddress,
            },
          }),
        ),
      );
      const { payload } = generated.intent;
      console.log("Intent the company wallet signs", {
        recipient: payload.recipient,
        message: parseJson(payload.message),
      });
      const signedData = await sign(payload);
      saveState(name, { ...entry, submitted: true });
      console.log(
        "Submitted",
        accepted(
          "submit-intent",
          await oneClick("POST", "/v0/submit-intent", {
            session,
            body: { type: "swap_transfer", signedData },
          }),
        ),
      );
    }
    return settle(session, entry.depositAddress);
  };

  if (step !== "check" && !hasPartnerKey) {
    throw new Error(
      "1Click refuses a confidential quote without a partner key: set ONECLICK_API_KEY",
    );
  }
  const session = await signIn();

  if (step === "check") {
    console.log("Company account", companyAccount);
    console.log("1Click partner key set:", hasPartnerKey);
    console.log(
      "Its key is registered with intents.near:",
      await viewIntents("has_public_key", {
        account_id: companyAccount,
        public_key: (await signer.getPublicKey()).toString(),
      }),
    );
    await showBalances("Balances", session);

    const history = await oneClick("GET", "/v0/account/history", { session });
    console.log("History", `${String(history.status)} ${brief(history.body)}`);

    const amount = spikeAmount(values.usdc);
    const baseRecipient = values["base-recipient"] ?? wallet.transitAddress;
    if (baseRecipient) {
      console.log(
        `Dry quotes, ${toUsdc(amount)} USDC from NEAR to Base, by confidentiality level`,
      );
      for (const confidentiality of CONFIDENTIALITY_LEVELS) {
        await dryQuote(confidentiality, session, {
          originAsset: nearUsdc,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
          amount,
          slippageBps: 100,
          depositType: "ORIGIN_CHAIN",
          recipientType: "DESTINATION_CHAIN",
          refundType: "ORIGIN_CHAIN",
          recipient: baseRecipient,
          refundTo: relayer.accountId,
          confidentiality,
        });
      }
    }

    console.log(
      `Dry quotes, ${toUsdc(amount)} USDC through the confidential account`,
    );
    await dryQuote("move in from USDC on NEAR", session, {
      originAsset: nearUsdc,
      destinationAsset: nearUsdc,
      amount,
      slippageBps: 0,
      depositType: "ORIGIN_CHAIN",
      recipientType: "CONFIDENTIAL_INTENTS",
      refundType: "ORIGIN_CHAIN",
      recipient: companyAccount,
      refundTo: relayer.accountId,
    });
    await dryQuote("fund-in from USDC on Base", session, {
      originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
      destinationAsset: nearUsdc,
      amount,
      slippageBps: 100,
      depositType: "ORIGIN_CHAIN",
      recipientType: "CONFIDENTIAL_INTENTS",
      refundType: "CONFIDENTIAL_INTENTS",
      recipient: companyAccount,
      refundTo: companyAccount,
    });
    if (baseRecipient) {
      await dryQuote("pay out to Base", session, {
        originAsset: nearUsdc,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        amount,
        slippageBps: 100,
        depositType: "CONFIDENTIAL_INTENTS",
        recipientType: "DESTINATION_CHAIN",
        refundType: "CONFIDENTIAL_INTENTS",
        recipient: baseRecipient,
        refundTo: companyAccount,
      });
    }
    if (baseRecipient) {
      await dryQuote("Base hop for an exact amount out", session, {
        swapType: "EXACT_OUTPUT",
        originAsset: nearUsdc,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        amount,
        slippageBps: 100,
        depositType: "CONFIDENTIAL_INTENTS",
        recipientType: "DESTINATION_CHAIN",
        refundType: "CONFIDENTIAL_INTENTS",
        recipient: baseRecipient,
        refundTo: companyAccount,
      });
    }
    await dryQuote("sweep from Base", session, {
      originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
      destinationAsset: nearUsdc,
      amount,
      slippageBps: 100,
      depositType: "ORIGIN_CHAIN",
      recipientType: "CONFIDENTIAL_INTENTS",
      refundType: "ORIGIN_CHAIN",
      recipient: companyAccount,
      refundTo: baseRecipient ?? companyAccount,
    });
    await dryQuote("pay out to Solana", session, {
      originAsset: nearUsdc,
      destinationAsset: ONE_CLICK_USDC_ASSET_IDS.solana,
      amount,
      slippageBps: 100,
      depositType: "CONFIDENTIAL_INTENTS",
      recipientType: "DESTINATION_CHAIN",
      refundType: "CONFIDENTIAL_INTENTS",
      recipient: "11111111111111111111111111111111",
      refundTo: companyAccount,
    });
    await dryQuote("pay out to USDC on NEAR", session, {
      originAsset: nearUsdc,
      destinationAsset: nearUsdc,
      amount,
      slippageBps: 0,
      depositType: "CONFIDENTIAL_INTENTS",
      recipientType: "DESTINATION_CHAIN",
      refundType: "CONFIDENTIAL_INTENTS",
      recipient: relayer.accountId,
      refundTo: companyAccount,
    });
  }

  if (step === "intent") {
    const baseRecipient = values["base-recipient"] ?? wallet.transitAddress;
    if (!baseRecipient) {
      throw new Error("Pass --base-recipient <address on Base>");
    }
    const legs = [
      {
        label: "exact amount in, to Base",
        swapType: "EXACT_INPUT",
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        slippageBps: 100,
        recipient: baseRecipient,
      },
      {
        label: "exact amount out, to Base",
        swapType: "EXACT_OUTPUT",
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        slippageBps: 100,
        recipient: baseRecipient,
      },
      {
        label: "exact amount in, to USDC on NEAR",
        swapType: "EXACT_INPUT",
        destinationAsset: nearUsdc,
        slippageBps: 0,
        recipient: relayer.accountId,
      },
    ] as const;
    for (const leg of legs) {
      const { body, depositAddress } = await firmQuote(session, {
        dry: false,
        swapType: leg.swapType,
        originAsset: nearUsdc,
        destinationAsset: leg.destinationAsset,
        amount: spikeAmount(values.pay),
        slippageBps: leg.slippageBps,
        depositType: "CONFIDENTIAL_INTENTS",
        recipientType: "DESTINATION_CHAIN",
        refundType: "CONFIDENTIAL_INTENTS",
        recipient: leg.recipient,
        refundTo: companyAccount,
      });
      const generated = await oneClick("POST", "/v0/generate-intent", {
        session,
        body: {
          type: "swap_transfer",
          standard: "nep413",
          signerId: companyAccount,
          depositAddress,
        },
      });
      console.log(
        JSON.stringify(
          { leg: leg.label, quoteResponse: body, generated },
          null,
          2,
        ),
      );
    }
  }

  if (step === "move-in") {
    await showBalances("Before", session);
    let entry = readState()["move-in"];
    if (!entry) {
      const relayerUsdc = await runtime.runPromise(
        rpc.usdcBalance(relayer.accountId),
      );
      if (relayerUsdc < spikeAmount(values.usdc)) {
        throw new Error(
          `The gas relayer holds ${toUsdc(relayerUsdc)} USDC, less than --usdc`,
        );
      }
      const { body, quote, depositAddress } = await firmQuote(session, {
        dry: false,
        originAsset: nearUsdc,
        destinationAsset: nearUsdc,
        amount: spikeAmount(values.usdc),
        slippageBps: 0,
        depositType: "ORIGIN_CHAIN",
        recipientType: "CONFIDENTIAL_INTENTS",
        refundType: "ORIGIN_CHAIN",
        recipient: companyAccount,
        refundTo: relayer.accountId,
      });
      // A quote 1Click didn't sign could name anyone's deposit address.
      if (
        !verifyQuoteSignature(
          body as OneClickQuoteResponse,
          ONE_CLICK_QUOTE_SIGNER_PUBLIC_KEY,
        )
      ) {
        throw new Error("The quote isn't signed by 1Click");
      }
      console.log("Quote", {
        amountIn: toUsdc(BigInt(quote.amountIn)),
        amountOut: toUsdc(BigInt(quote.amountOut)),
        depositAddress,
      });
      entry = { depositAddress };
      saveState("move-in", entry);
    }
    const { depositAddress } = entry;
    if (!entry.depositTxHash) {
      const registered = await runtime.runPromise(
        relayer.registerUsdcAccount({
          accountId: depositAddress,
          beforeBroadcast: () => Effect.void,
        }),
      );
      console.log("Deposit address registered", registered.txHash);
      const paid = await runtime.runPromise(
        relayer.sendUsdc({
          to: depositAddress,
          amount: spikeAmount(values.usdc),
          beforeBroadcast: (txHash) =>
            Effect.sync(() => {
              saveState("move-in", { depositAddress, depositTxHash: txHash });
            }),
        }),
      );
      console.log(
        `Relayer → deposit address: https://nearblocks.io/txns/${paid.txHash}`,
      );
      const outcome = await runtime.runPromise(
        relayer.awaitOutcome(paid.txHash),
      );
      if (outcome?.succeeded === false) {
        saveState("move-in", { depositAddress });
        throw new Error(
          "The relayer's transfer failed on chain; nothing moved",
        );
      }
    }
    await settle(session, depositAddress);
    await showBalances("After", session);
  }

  if (step === "pay") {
    const baseRecipient = values["base-recipient"];
    if (!baseRecipient || !/^0x[0-9a-fA-F]{40}$/.test(baseRecipient)) {
      throw new Error("Pass --base-recipient <address on Base>");
    }
    await showBalances("Before", session);
    await payFromConfidentialAccount("pay", session, {
      destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
      amount: spikeAmount(values.pay),
      slippageBps: 100,
      recipient: baseRecipient,
      recipientType: "DESTINATION_CHAIN",
    });
    await showBalances("After", session);
  }

  if (step === "move-out") {
    await showBalances("Before", session);
    const held = (await confidentialBalances(session)).find((balance) =>
      balance.tokenId.endsWith(nearUsdc),
    );
    const amount = BigInt(held?.available ?? "0");
    if (amount === 0n && !readState()["move-out"]) {
      throw new Error("The confidential account holds no USDC");
    }
    if (amount > MAX_SPIKE_USDC) {
      throw new Error(
        `The confidential account holds ${toUsdc(amount)} USDC, more than a spike moves`,
      );
    }
    await payFromConfidentialAccount("move-out", session, {
      destinationAsset: nearUsdc,
      amount,
      slippageBps: 0,
      recipient: relayer.accountId,
      recipientType: "DESTINATION_CHAIN",
    });
    await showBalances("After", session);
  }
} finally {
  await runtime.dispose();
}
