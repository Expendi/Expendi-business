import { createHmac, randomBytes } from "node:crypto";
import { Effect, Layer, Redacted } from "effect";

import type { TransactionReceipt } from "../../services/chain/base.js";
import type { EmailMessage } from "../../services/email/email-sender.js";
import type {
  PaycrestOrder,
  PaycrestOrderRequest,
} from "../../services/paycrest/paycrest-client.js";
import type {
  OtpProviderErrorCode,
  VerificationCheckResult,
} from "../../services/phone-verification/otp-provider.js";
import type {
  CreatePolicyInput,
  CreateWalletInput,
  PrivyWalletRecord,
  SendUsdcInput,
  SentTransaction,
} from "../../services/wallet/privy-wallets.js";
import {
  AlchemyWebhook,
  makeAlchemyWebhook,
} from "../../services/alchemy/alchemy-webhook.js";
import { ApprovalSettings } from "../../services/approval/passkeys.js";
import { BaseRpc, BaseRpcError } from "../../services/chain/base-rpc.js";
import {
  EmailSender,
  EmailSendError,
} from "../../services/email/email-sender.js";
import { fromMicro, toMicro } from "../../services/paycrest/amounts.js";
import {
  Paycrest,
  PaycrestError,
  verifyPaycrestSignature,
} from "../../services/paycrest/paycrest-client.js";
import {
  OtpProvider,
  OtpProviderError,
} from "../../services/phone-verification/otp-provider.js";
import { WalletSettings } from "../../services/wallet/company-wallet.js";
import {
  PrivyWalletError,
  PrivyWallets,
  SendOutcomeUnknown,
  SendRefused,
} from "../../services/wallet/privy-wallets.js";

export const TEST_WALLET_SETTINGS = {
  managementQuorumId: "kq-management",
  runtimeSignerId: "kq-runtime",
  defaultPerTransactionMaxUsdc: 5_000_000_000n,
} as const;

export const TEST_RP_ID = "business.expendi.test";
export const TEST_ORIGIN = `https://${TEST_RP_ID}`;

export const TestApprovalSettings = Layer.succeed(ApprovalSettings, {
  rpId: TEST_RP_ID,
  origins: [TEST_ORIGIN],
});

export const TestWalletSettings = Layer.succeed(
  WalletSettings,
  TEST_WALLET_SETTINGS,
);

export const randomAddress = (): string =>
  `0x${randomBytes(20).toString("hex")}`;

type FailingCall = "createPolicy" | "createWallet" | "findWalletByExternalId";

/**
 * In-memory Privy. Like the real API, a repeated idempotency key replays
 * the first result instead of creating a second policy or wallet.
 */
export function makeFakePrivyWallets() {
  const policies = new Map<string, { id: string; input: CreatePolicyInput }>();
  const wallets = new Map<
    string,
    PrivyWalletRecord & { readonly input: CreateWalletInput }
  >();
  const calls: Record<FailingCall, number> = {
    createPolicy: 0,
    createWallet: 0,
    findWalletByExternalId: 0,
  };
  const failures = new Map<FailingCall, number>();
  /** Every send that reached "Privy", in order; replays aren't repeated. */
  const sends: SendUsdcInput[] = [];
  const sent = new Map<string, SentTransaction>();
  type SendOutcome =
    "sent" | "sent_without_hash" | "refused" | "policy_violation" | "unknown";
  const sendOutcomes: SendOutcome[] = [];

  const maybeFail = (
    call: FailingCall,
  ): Effect.Effect<void, PrivyWalletError> => {
    calls[call] += 1;
    const remaining = failures.get(call) ?? 0;
    if (remaining === 0) return Effect.void;
    failures.set(call, remaining - 1);
    return Effect.fail(
      new PrivyWalletError({ message: `fake ${call} failure` }),
    );
  };

  const state = {
    policies,
    wallets,
    calls,
    /** The next `times` calls of `call` fail. */
    failNext(call: FailingCall, times = 1) {
      failures.set(call, times);
    },
    sends,
    /** Queue outcomes for the next sends; each send without one succeeds. */
    nextSends(...outcomes: SendOutcome[]) {
      sendOutcomes.push(...outcomes);
    },
    /** A wallet created outside this fake's idempotency (e.g. >24h ago). */
    seedWallet(record: PrivyWalletRecord, input: CreateWalletInput) {
      wallets.set(`seeded-${record.id}`, { ...record, input });
    },
    reset() {
      policies.clear();
      wallets.clear();
      failures.clear();
      sends.length = 0;
      sent.clear();
      sendOutcomes.length = 0;
      for (const call of Object.keys(calls) as FailingCall[]) calls[call] = 0;
    },
  };

  const layer = Layer.succeed(PrivyWallets, {
    createPolicy: (input) =>
      maybeFail("createPolicy").pipe(
        Effect.map(() => {
          const existing = policies.get(input.idempotencyKey);
          if (existing) return { policyId: existing.id };
          const id = `policy-${policies.size + 1}-${randomBytes(4).toString("hex")}`;
          policies.set(input.idempotencyKey, { id, input });
          return { policyId: id };
        }),
      ),
    createWallet: (input) =>
      maybeFail("createWallet").pipe(
        Effect.map(() => {
          const existing = wallets.get(input.idempotencyKey);
          if (existing) return existing;
          const record = {
            id: `wallet-${randomBytes(6).toString("hex")}`,
            address: randomAddress(),
            ownerId: input.ownerQuorumId,
            policyIds: [input.policyId],
            signerIds: [input.signerQuorumId],
            input,
          };
          wallets.set(input.idempotencyKey, record);
          return record;
        }),
      ),
    findWalletByExternalId: (externalId) =>
      maybeFail("findWalletByExternalId").pipe(
        Effect.map(
          () =>
            [...wallets.values()].find(
              (wallet) => wallet.input.externalId === externalId,
            ) ?? null,
        ),
      ),
    sendUsdc: (input) => {
      const replay = sent.get(input.idempotencyKey);
      if (replay) return Effect.succeed(replay);
      const outcome = sendOutcomes.shift() ?? "sent";
      if (outcome === "refused" || outcome === "policy_violation") {
        return Effect.fail(
          new SendRefused({
            message: `fake ${outcome}`,
            status: 400,
            policyViolation: outcome === "policy_violation",
          }),
        );
      }
      sends.push(input);
      if (outcome === "unknown") {
        return Effect.fail(
          new SendOutcomeUnknown({ message: "fake timeout", cause: null }),
        );
      }
      const result = {
        txHash:
          outcome === "sent" ? `0x${randomBytes(32).toString("hex")}` : null,
        privyTransactionId: `ptx-${randomBytes(6).toString("hex")}`,
      };
      sent.set(input.idempotencyKey, result);
      return Effect.succeed(result);
    },
  });

  return { layer, state };
}

export const TEST_ALCHEMY_SIGNING_KEY = "whsec_test_alchemy_key";

export function signAlchemyBody(rawBody: string): string {
  return createHmac("sha256", TEST_ALCHEMY_SIGNING_KEY)
    .update(rawBody, "utf8")
    .digest("hex");
}

/**
 * The real Alchemy adapter with a test signing key, talking to a fake
 * Notify API that records the addresses it was asked to watch.
 */
export function makeFakeAlchemyWebhook() {
  const watched: string[] = [];
  let failures = 0;
  const notifyApi: typeof fetch = (_input, init) => {
    if (failures > 0) {
      failures -= 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(rawBody) as {
      addresses_to_add: string[];
    };
    watched.push(...body.addresses_to_add);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const state = {
    watched,
    failNext(times = 1) {
      failures = times;
    },
  };
  const layer = Layer.succeed(
    AlchemyWebhook,
    makeAlchemyWebhook(
      {
        webhookId: "wh_test",
        signingKeys: Redacted.make(TEST_ALCHEMY_SIGNING_KEY),
        notifyToken: Redacted.make("test-notify-token"),
      },
      notifyApi,
    ),
  );
  return { layer, state };
}

/** Receipts keyed by lowercased transaction hash. */
export function makeFakeBaseRpc() {
  const receipts = new Map<string, TransactionReceipt>();
  let failures = 0;
  const state = {
    receipts,
    failNext(times = 1) {
      failures = times;
    },
  };
  const layer = Layer.succeed(BaseRpc, {
    getTransactionReceipt: (txHash) => {
      if (failures > 0) {
        failures -= 1;
        return Effect.fail(new BaseRpcError({ message: "fake RPC failure" }));
      }
      return Effect.succeed(receipts.get(txHash.toLowerCase()) ?? null);
    },
  });
  return { layer, state };
}

export const TEST_PAYCREST_SECRET = "pc_test_webhook_secret";

export function signPaycrestBody(rawBody: string): string {
  return createHmac("sha256", TEST_PAYCREST_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");
}

const KES_INSTITUTIONS = [
  { code: "SAFAKEPC", name: "M-PESA", type: "mobile_money" },
  { code: "KCBLKENX", name: "Kenya Commercial Bank", type: "bank" },
  { code: "EQBLKENA", name: "Equity Bank", type: "bank" },
] as const;

/**
 * In-memory Paycrest. `rateFor` decides the sell rate for an order size,
 * so tests can model rate bands; created orders echo the request back
 * with deposit instructions, unless `nextOrder` rewrites them.
 */
export function makeFakePaycrest() {
  const created: PaycrestOrderRequest[] = [];
  const orders = new Map<string, PaycrestOrder>();
  const rateCalls: string[] = [];
  const state = {
    created,
    orders,
    rateCalls,
    rateFor: (_usdcAmount: string): string => "128.68",
    transactionFee: "0.02",
    /** Rewrites the next created order, e.g. to make it unsafe. */
    nextOrder: null as ((order: PaycrestOrder) => PaycrestOrder) | null,
    /** Fails the next createOrder: a lost reply, or a definite refusal. */
    nextCreateFailure: null as "ambiguous" | "refused" | null,
    failGetOrder: false,
    failRate: false,
    reset() {
      created.length = 0;
      orders.clear();
      rateCalls.length = 0;
      state.rateFor = () => "128.68";
      state.transactionFee = "0.02";
      state.nextOrder = null;
      state.nextCreateFailure = null;
      state.failGetOrder = false;
      state.failRate = false;
    },
  };
  const unavailable = (code: string) =>
    new PaycrestError({
      message: `fake Paycrest ${code}`,
      status: 503,
      code,
      ambiguous: false,
    });

  const layer = Layer.succeed(Paycrest, {
    rate: (usdcAmount) => {
      rateCalls.push(usdcAmount);
      return state.failRate
        ? Effect.fail(unavailable("TRANSPORT_ERROR"))
        : Effect.succeed({
            rate: state.rateFor(usdcAmount),
            providerIds: ["fakeProvider"],
          });
    },
    institutions: () => Effect.succeed(KES_INSTITUTIONS),
    verifyAccount: () => Effect.succeed("OK"),
    createOrder: (request) => {
      const failure = state.nextCreateFailure;
      state.nextCreateFailure = null;
      if (failure) {
        if (failure === "ambiguous") created.push(request);
        return Effect.fail(
          new PaycrestError({
            message: `fake Paycrest ${failure}`,
            status: failure === "ambiguous" ? 503 : 400,
            code: failure === "ambiguous" ? "TRANSPORT_ERROR" : "HTTP_400",
            ambiguous: failure === "ambiguous",
          }),
        );
      }
      created.push(request);
      const amount = toMicro(request.amount);
      const fee = toMicro(state.transactionFee);
      let order: PaycrestOrder = {
        id: `order-${randomBytes(6).toString("hex")}`,
        status: "initiated",
        direction: "offramp",
        amount: request.amount,
        rate: request.rate,
        reference: request.reference,
        transactionFee: state.transactionFee,
        senderFee: "0",
        source: { ...request.source },
        destination: {
          type: "fiat",
          currency: "KES",
          country: "KE",
          recipient: { ...request.destination.recipient },
        },
        providerAccount: {
          network: "base",
          receiveAddress: randomAddress(),
          validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
          amountToTransfer: fromMicro(amount + fee),
          currency: "USDC",
        },
      };
      if (state.nextOrder) {
        order = state.nextOrder(order);
        state.nextOrder = null;
      }
      orders.set(order.id, order);
      return Effect.succeed(order);
    },
    verifyWebhookSignature: (rawBody, signature) =>
      verifyPaycrestSignature(rawBody, signature, TEST_PAYCREST_SECRET),
    getOrder: (id) => {
      if (state.failGetOrder) {
        return Effect.fail(unavailable("TRANSPORT_ERROR"));
      }
      const order = orders.get(id);
      return order
        ? Effect.succeed(order)
        : Effect.fail(
            new PaycrestError({
              message: "fake Paycrest order not found",
              status: 404,
              code: "HTTP_404",
              ambiguous: false,
            }),
          );
    },
  });
  return { layer, state };
}

/** Records every email "sent"; `failNext` makes the next sends fail. */
export function makeFakeEmailSender() {
  const sent: EmailMessage[] = [];
  let failures = 0;
  const state = {
    sent,
    failNext(times = 1) {
      failures = times;
    },
    reset() {
      sent.length = 0;
      failures = 0;
    },
  };
  const layer = Layer.succeed(EmailSender, {
    send: (message) => {
      if (failures > 0) {
        failures -= 1;
        return Effect.fail(
          new EmailSendError({ message: "fake Resend failure" }),
        );
      }
      sent.push(message);
      return Effect.void;
    },
  });
  return { layer, state };
}

/** The code the fake SMS provider sends to every number. */
export const TEST_OTP_CODE = "246810";

/**
 * In-memory Telnyx Verify. A send makes `TEST_OTP_CODE` live for that
 * number until a check accepts it; like Telnyx, an accepted code can't be
 * checked again. `failNextSend` and `nextCheck` steer the next calls.
 */
export function makeFakeOtpProvider() {
  const sends: string[] = [];
  const checks: { readonly to: string; readonly code: string }[] = [];
  const live = new Set<string>();
  let sendFailure: OtpProviderErrorCode | null = null;
  let checkOverride: VerificationCheckResult | null = null;
  const state = {
    sends,
    checks,
    failNextSend(code: OtpProviderErrorCode) {
      sendFailure = code;
    },
    nextCheck(result: VerificationCheckResult) {
      checkOverride = result;
    },
    reset() {
      sends.length = 0;
      checks.length = 0;
      live.clear();
      sendFailure = null;
      checkOverride = null;
    },
  };
  const layer = Layer.succeed(OtpProvider, {
    startVerification: ({ to }) => {
      const failure = sendFailure;
      sendFailure = null;
      if (failure) {
        return Effect.fail(
          new OtpProviderError({ code: failure, message: `fake ${failure}` }),
        );
      }
      sends.push(to);
      live.add(to);
      return Effect.succeed({
        providerRef: `verification-${randomBytes(6).toString("hex")}`,
      });
    },
    checkVerification: ({ to, code }) => {
      checks.push({ to, code });
      const override = checkOverride;
      checkOverride = null;
      return Effect.sync((): VerificationCheckResult => {
        if (override) return override;
        if (!live.has(to)) return { approved: false, reason: "expired" };
        if (code !== TEST_OTP_CODE)
          return { approved: false, reason: "invalid" };
        live.delete(to);
        return { approved: true };
      });
    },
  });
  return { layer, state };
}
