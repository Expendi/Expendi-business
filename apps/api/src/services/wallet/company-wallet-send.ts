import type { SignedDelegate } from "near-api-js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import {
  actions,
  DelegateAction,
  encodeSignedDelegate,
  Signature,
} from "near-api-js";

import type { DatabaseService } from "../../db/client.js";
import type {
  CompanyWalletSend,
  CompanyWalletSendKind,
  CompanyWalletSendStatus,
} from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { NearRpcError } from "../chain/near-rpc.js";
import type { NearTransactionOutcome } from "../chain/near.js";
import type { PrivyWalletError } from "./privy-wallets.js";
import { companyWalletSends, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { NearRpc } from "../chain/near-rpc.js";
import {
  implicitAccountPublicKey,
  isImplicitNearAccount,
  NEAR_ED25519,
  NearChain,
  nearUsdcTransfersIn,
  normaliseNearAccountId,
  usdcTransferAction,
  usdcTransferCallAction,
} from "../chain/near.js";
import {
  nearSigningFailure,
  PrivyWallets,
  SendOutcomeUnknown,
  SendRefused,
} from "./privy-wallets.js";

/**
 * How many blocks a signed send stays valid for: about two minutes at
 * NEAR's block time. Short, because until it passes an unconfirmed send
 * can't be called off and nothing else can leave the wallet.
 */
export const DELEGATE_TTL_BLOCKS = 200n;

const ED25519_SIGNATURE_LENGTH = 64;

/**
 * Another send from the same company wallet hasn't finished. Nothing was
 * signed for this one, so trying again shortly is safe.
 */
export class CompanyWalletBusy extends Data.TaggedError("CompanyWalletBusy")<{
  readonly message: string;
  /** Null when the other send finished before it could be looked up. */
  readonly inFlightSendId: string | null;
}> {}

export interface CompanyWalletSendInput {
  readonly organizationId: string;
  /**
   * Names what the send is for, e.g. one payout. While a send under a key
   * is in flight or has run, the key never produces another.
   */
  readonly sendKey: string;
  /** A NEAR account ID, already normalised. */
  readonly to: string;
  /** USDC base units. */
  readonly amount: bigint;
}

/** A send the chain ran and that moved the USDC. */
export interface CompanyWalletSendReceipt {
  readonly sendId: string;
  /** The relayer transaction that carried it. Base58: never lowercase it. */
  readonly txHash: string;
  readonly blockHeight: bigint;
}

export type CompanyWalletSendError =
  | SendRefused
  | SendOutcomeUnknown
  | CompanyWalletBusy
  | PrivyWalletError
  | NearRpcError
  | DatabaseError;

export type CompanyWalletSendDeps =
  DatabaseService | PrivyWallets | NearRpc | NearRelayer | NearChain;

type SentTransfer = Pick<
  CompanyWalletSend,
  "kind" | "senderAccountId" | "receiverAccountId" | "usdcAmount"
>;

/**
 * - `executed`: the delegate action ran and the USDC moved as asked.
 * - `failed`: it ran, but the USDC call failed or returned everything, so
 *   nothing stayed moved.
 * - `not_run`: the chain rejected the delegate action in this transaction,
 *   e.g. as expired. It may still run in another.
 * - `unclear`: it ran and the logs don't add up to either of the above.
 */
export type DelegateVerdict = "executed" | "failed" | "not_run" | "unclear";

function usedAmount(successValue: string | null): bigint | null {
  if (successValue === null) return null;
  const text = Buffer.from(successValue, "base64").toString("utf8");
  const match = /^"(\d{1,39})"$/.exec(text);
  return match?.[1] === undefined ? null : BigInt(match[1]);
}

/**
 * What one relayer transaction did with a saved send, read from its final
 * outcome. Strict on purpose: anything that isn't exactly the transfer that
 * was signed, or exactly nothing, is `unclear` and goes to a person.
 */
export function delegateVerdict(
  outcome: NearTransactionOutcome,
  send: SentTransfer,
  usdcContractId: string,
): DelegateVerdict {
  const ownReceipt = outcome.receipts.find(
    (receipt) => receipt.receiptId === outcome.ownReceiptId,
  );
  if (
    outcome.receiverId !== send.senderAccountId ||
    ownReceipt?.executorId !== send.senderAccountId
  ) {
    return "unclear";
  }
  if (!ownReceipt.succeeded) return "not_run";

  const transfers = nearUsdcTransfersIn(outcome, usdcContractId);
  const [sent, returned] = transfers;
  const sentAsSigned =
    sent?.from === send.senderAccountId &&
    sent.to === send.receiverAccountId &&
    sent.amount === send.usdcAmount;
  const nothingMoved = transfers.length === 0;

  if (send.kind === "transfer") {
    if (outcome.succeeded && sentAsSigned && transfers.length === 1) {
      return "executed";
    }
    return !outcome.succeeded && nothingMoved ? "failed" : "unclear";
  }

  if (!outcome.succeeded) return nothingMoved ? "failed" : "unclear";
  const used = usedAmount(outcome.successValue);
  if (used === send.usdcAmount && sentAsSigned && transfers.length === 1) {
    return "executed";
  }
  const returnedInFull =
    sentAsSigned &&
    transfers.length === 2 &&
    returned?.from === send.receiverAccountId &&
    returned.to === send.senderAccountId &&
    returned.amount === send.usdcAmount;
  return used === 0n && (nothingMoved || returnedInFull) ? "failed" : "unclear";
}

/**
 * The delegate action a saved send stands for. Built only from the row, so
 * the same row always yields the same bytes, and the only actions it can
 * hold are the two USDC transfers.
 */
function delegateActionFor(
  send: CompanyWalletSend,
  usdcContractId: string,
): DelegateAction {
  return new DelegateAction({
    senderId: send.senderAccountId,
    receiverId: usdcContractId,
    actions: [
      send.kind === "transfer"
        ? usdcTransferAction(send.receiverAccountId, send.usdcAmount)
        : usdcTransferCallAction(
            send.receiverAccountId,
            send.usdcAmount,
            send.msg ?? "",
          ),
    ],
    nonce: send.nonce,
    maxBlockHeight: send.maxBlockHeight,
    publicKey: implicitAccountPublicKey(send.senderAccountId),
  });
}

/**
 * The signed delegate action exactly as it was saved. It is rebuilt from the
 * row around the saved signature and must encode to the saved bytes, so a
 * retry can only ever relay what was signed the first time.
 */
function savedSignedDelegate(
  send: CompanyWalletSend,
  usdcContractId: string,
): Effect.Effect<SignedDelegate, SendOutcomeUnknown> {
  return Effect.try({
    try: () => {
      const saved = Buffer.from(send.signedDelegate ?? "", "base64");
      const rebuilt = actions.signedDelegate({
        delegateAction: delegateActionFor(send, usdcContractId),
        signature: new Signature({
          keyType: NEAR_ED25519,
          data: Uint8Array.from(
            saved.subarray(saved.length - ED25519_SIGNATURE_LENGTH),
          ),
        }),
      }).signedDelegate;
      if (
        rebuilt === undefined ||
        !Buffer.from(encodeSignedDelegate(rebuilt)).equals(saved)
      ) {
        throw new Error(
          "the row no longer encodes to the bytes that were signed",
        );
      }
      return rebuilt;
    },
    catch: (cause) =>
      new SendOutcomeUnknown({
        message: `Saved send ${send.id} can't be relayed again`,
        cause,
      }),
  });
}

const LIVE: CompanyWalletSendStatus[] = [
  "reserved",
  "signed",
  "executed",
  "failed",
];
const IN_FLIGHT: CompanyWalletSendStatus[] = ["reserved", "signed"];

const refused = (
  message: string,
  options: { readonly status?: number; readonly overCap?: boolean } = {},
) =>
  new SendRefused({
    message,
    status: options.status ?? 400,
    policyViolation: options.overCap ?? false,
  });

/** After a send is signed, no failure may read as "nothing moved". */
const unknownOnceSigned =
  (send: CompanyWalletSend) =>
  <A, E, R>(
    effect: Effect.Effect<A, E | SendOutcomeUnknown, R>,
  ): Effect.Effect<A, SendOutcomeUnknown, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof SendOutcomeUnknown
          ? cause
          : new SendOutcomeUnknown({
              message: `The outcome of send ${send.id} couldn't be read. It may have run: call again with the same key to find out.`,
              cause,
            }),
      ),
    );

interface TransferRequest extends CompanyWalletSendInput {
  readonly kind: CompanyWalletSendKind;
  readonly msg: string | null;
}

interface SendingWallet {
  readonly id: string;
  readonly accountId: string;
  readonly privyWalletId: string;
}

const sendById = (organizationId: string, sendId: string) =>
  withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(companyWalletSends)
        .where(eq(companyWalletSends.id, sendId))
        .limit(1),
    ),
  ).pipe(
    Effect.flatMap(([send]) =>
      send ? Effect.succeed(send) : Effect.dieMessage("saved send vanished"),
    ),
  );

/**
 * Moves a send out of `from` into a final or later status, unless a
 * concurrent attempt already moved it; returns the row as it now stands.
 */
const advance = (
  send: CompanyWalletSend,
  from: CompanyWalletSendStatus,
  changes: Partial<
    Pick<
      CompanyWalletSend,
      "status" | "signedDelegate" | "txHash" | "blockHeight" | "failure"
    >
  >,
) =>
  withScope({ organizationId: send.organizationId }, (tx) =>
    query(() =>
      tx
        .update(companyWalletSends)
        .set(changes)
        .where(
          and(
            eq(companyWalletSends.id, send.id),
            eq(companyWalletSends.status, from),
          ),
        )
        .returning(),
    ),
  ).pipe(
    Effect.flatMap(([advanced]) =>
      advanced
        ? Effect.succeed(advanced)
        : sendById(send.organizationId, send.id),
    ),
  );

const liveSendFor = (organizationId: string, sendKey: string) =>
  withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(companyWalletSends)
        .where(
          and(
            eq(companyWalletSends.organizationId, organizationId),
            eq(companyWalletSends.sendKey, sendKey),
            inArray(companyWalletSends.status, LIVE),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([send]) => send ?? null));

function sendingWallet(
  organizationId: string,
): Effect.Effect<SendingWallet, SendRefused | DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(wallets)
        .where(eq(wallets.organizationId, organizationId))
        .limit(1),
    ),
  ).pipe(
    Effect.flatMap(([wallet]) =>
      wallet?.status === "active" &&
      wallet.chain === "near" &&
      wallet.privyWalletId !== null &&
      wallet.address !== null &&
      isImplicitNearAccount(wallet.address)
        ? Effect.succeed({
            id: wallet.id,
            accountId: wallet.address,
            privyWalletId: wallet.privyWalletId,
          })
        : Effect.fail(
            refused("The company has no active company wallet on NEAR", {
              status: 409,
            }),
          ),
    ),
  );
}

/**
 * Reads from the chain whether a signed send has run, and records it once
 * that is final. It never relays anything.
 *
 * - It ran if a relayer transaction saved for it shows that.
 * - It never ran, and never will, if a final block past its expiry still
 *   shows the wallet's nonce below the send's own: running it would have
 *   raised the nonce to at least that. The nonce is read at that exact
 *   block, so a node that is behind can't answer from before the send.
 * - Before its expiry it is still open and comes back unchanged.
 * - Past its expiry with the nonce used and no transaction to show for it,
 *   nobody can say, and that is `SendOutcomeUnknown`.
 */
function settle(
  send: CompanyWalletSend,
): Effect.Effect<
  CompanyWalletSend,
  SendOutcomeUnknown | NearRpcError | DatabaseError,
  DatabaseService | NearRpc | NearRelayer | NearChain
> {
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const relayer = yield* NearRelayer;
    const chain = yield* NearChain;
    const current = yield* sendById(send.organizationId, send.id);
    if (current.status !== "signed") return current;

    for (const txHash of [...current.relayTxHashes].reverse()) {
      const outcome = yield* rpc.transactionOutcome(txHash, relayer.accountId);
      if (outcome === null) continue;
      const verdict = delegateVerdict(outcome, current, chain.usdcContractId);
      if (verdict === "not_run") continue;
      if (verdict === "unclear") {
        return yield* Effect.fail(
          new SendOutcomeUnknown({
            message: `Send ${current.id} ran in ${txHash}, but what it moved doesn't match what was signed`,
            cause: null,
          }),
        );
      }
      return yield* advance(current, "signed", {
        status: verdict,
        txHash,
        blockHeight: outcome.blockHeight,
        failure:
          verdict === "failed"
            ? "The chain ran it, but the USDC contract moved nothing"
            : null,
      });
    }

    const final = yield* rpc.finalBlock();
    if (final.height <= current.maxBlockHeight) return current;
    const nonce = yield* rpc.accessKeyNonce({
      accountId: current.senderAccountId,
      publicKey: implicitAccountPublicKey(current.senderAccountId).toString(),
      atBlockHeight: final.height,
    });
    if (nonce !== null && nonce < current.nonce) {
      return yield* advance(current, "signed", {
        status: "expired",
        failure: `Expired at block ${current.maxBlockHeight} without running`,
      });
    }
    return yield* Effect.fail(
      new SendOutcomeUnknown({
        message: `Send ${current.id} has expired and the wallet's nonce has reached it, but no saved transaction shows it running`,
        cause: null,
      }),
    );
  });
}

/**
 * A reserved send nobody signed before its expiry. Nothing was saved to
 * relay, so nothing can have moved, and its key and the wallet are freed.
 */
function expireIfUnsigned(
  send: CompanyWalletSend,
): Effect.Effect<
  CompanyWalletSend,
  NearRpcError | DatabaseError,
  DatabaseService | NearRpc
> {
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const final = yield* rpc.finalBlock();
    return final.height <= send.maxBlockHeight
      ? send
      : yield* advance(send, "reserved", {
          status: "expired",
          failure: "Expired before it was signed",
        });
  });
}

/** Brings a saved send up to date with the chain without relaying it. */
function refresh(
  send: CompanyWalletSend,
): Effect.Effect<
  CompanyWalletSend,
  SendOutcomeUnknown | NearRpcError | DatabaseError,
  DatabaseService | NearRpc | NearRelayer | NearChain
> {
  if (send.status === "reserved") return expireIfUnsigned(send);
  if (send.status === "signed") {
    return settle(send).pipe(unknownOnceSigned(send));
  }
  return Effect.succeed(send);
}

/**
 * Takes the wallet's next nonce for a new send and saves it before anything
 * is signed. The row holds the wallet, so a second send can't be built
 * until this one is final, and the key, so the same payout can't be built
 * twice.
 */
function reserve(
  wallet: SendingWallet,
  request: TransferRequest,
  triesLeft = 2,
): Effect.Effect<
  CompanyWalletSend,
  SendRefused | CompanyWalletBusy | NearRpcError | DatabaseError,
  DatabaseService | NearRpc | NearRelayer | NearChain
> {
  const { organizationId } = request;
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const [final, chainNonce] = yield* Effect.all([
      rpc.finalBlock(),
      rpc.accessKeyNonce({
        accountId: wallet.accountId,
        publicKey: implicitAccountPublicKey(wallet.accountId).toString(),
      }),
    ]);
    if (chainNonce === null) {
      return yield* Effect.fail(
        refused(`Company wallet ${wallet.accountId} isn't on chain`, {
          status: 409,
        }),
      );
    }

    const reserved = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [used] = yield* query(() =>
          tx
            .select({
              highest: sql<
                string | null
              >`max(${companyWalletSends.nonce})::text`,
            })
            .from(companyWalletSends)
            .where(eq(companyWalletSends.walletId, wallet.id)),
        );
        const highestSaved = BigInt(used?.highest ?? "0");
        const [inserted] = yield* query(() =>
          tx
            .insert(companyWalletSends)
            .values({
              organizationId,
              walletId: wallet.id,
              sendKey: request.sendKey,
              kind: request.kind,
              senderAccountId: wallet.accountId,
              receiverAccountId: request.to,
              usdcAmount: request.amount,
              msg: request.msg,
              nonce:
                (chainNonce > highestSaved ? chainNonce : highestSaved) + 1n,
              maxBlockHeight: final.height + DELEGATE_TTL_BLOCKS,
            })
            .onConflictDoNothing()
            .returning(),
        );
        return inserted ?? null;
      }),
    );
    if (reserved !== null) return reserved;

    const sameKey = yield* liveSendFor(organizationId, request.sendKey);
    if (sameKey !== null) return sameKey;

    const [inFlight] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(companyWalletSends)
          .where(
            and(
              eq(companyWalletSends.walletId, wallet.id),
              inArray(companyWalletSends.status, IN_FLIGHT),
            ),
          )
          .limit(1),
      ),
    );
    // The send in the way may be one a crashed attempt left behind. If the
    // chain already settles it, or it finished just now, the wallet is free.
    const stillInFlight =
      inFlight !== undefined &&
      (yield* refresh(inFlight).pipe(
        Effect.map((refreshed) => IN_FLIGHT.includes(refreshed.status)),
        Effect.catchTag("SendOutcomeUnknown", () => Effect.succeed(true)),
      ));
    if (stillInFlight || triesLeft <= 1) {
      return yield* Effect.fail(
        new CompanyWalletBusy({
          message: `Company wallet ${wallet.accountId} has another send in flight`,
          inFlightSendId: inFlight?.id ?? null,
        }),
      );
    }
    return yield* reserve(wallet, request, triesLeft - 1);
  });
}

/**
 * Signs a reserved send with Privy and saves the signed bytes. This is the
 * only place a company wallet signature is asked for, and the cap is read
 * and checked here, immediately before, because Privy enforces nothing for
 * NEAR (docs/decisions/near-main-chain.md, "The spend cap").
 */
function sign(
  wallet: SendingWallet,
  send: CompanyWalletSend,
): Effect.Effect<
  CompanyWalletSend,
  SendRefused | PrivyWalletError | DatabaseError,
  DatabaseService | PrivyWallets | NearChain
> {
  const refuse = (refusal: SendRefused) =>
    advance(send, "reserved", {
      status: "refused",
      failure: refusal.message,
    }).pipe(Effect.zipRight(Effect.fail(refusal)));

  return Effect.gen(function* () {
    const privy = yield* PrivyWallets;
    const chain = yield* NearChain;

    const [cap] = yield* withScope(
      { organizationId: send.organizationId },
      (tx) =>
        query(() =>
          tx
            .select({ perTransactionMaxUsdc: wallets.perTransactionMaxUsdc })
            .from(wallets)
            .where(
              and(
                eq(wallets.id, wallet.id),
                eq(wallets.status, "active"),
                eq(wallets.address, send.senderAccountId),
              ),
            )
            .limit(1),
        ),
    );
    if (cap === undefined) {
      return yield* refuse(
        refused("The company wallet changed since the send was built", {
          status: 409,
        }),
      );
    }
    if (send.usdcAmount > cap.perTransactionMaxUsdc) {
      return yield* refuse(
        refused(
          `${send.usdcAmount} is over the wallet's per-transaction maximum of ${cap.perTransactionMaxUsdc} USDC base units`,
          { overCap: true },
        ),
      );
    }

    const signer = privy.nearSigner({
      privyWalletId: wallet.privyWalletId,
      accountId: wallet.accountId,
    });
    const signed = yield* Effect.tryPromise({
      try: () =>
        signer.signDelegateAction(
          delegateActionFor(send, chain.usdcContractId),
        ),
      catch: nearSigningFailure,
    }).pipe(Effect.catchTag("SendRefused", refuse));

    return yield* advance(send, "reserved", {
      status: "signed",
      signedDelegate: Buffer.from(
        encodeSignedDelegate(signed.signedDelegate),
      ).toString("base64"),
    });
  });
}

/**
 * Relays a signed send's saved bytes once more and reads what came of it.
 * Relaying twice is harmless: the chain runs a nonce once.
 */
function relayAndSettle(
  send: CompanyWalletSend,
): Effect.Effect<
  CompanyWalletSend,
  SendOutcomeUnknown,
  DatabaseService | NearRpc | NearRelayer | NearChain
> {
  return Effect.gen(function* () {
    const relayer = yield* NearRelayer;
    const chain = yield* NearChain;
    const signedDelegate = yield* savedSignedDelegate(
      send,
      chain.usdcContractId,
    );

    const relayed = yield* relayer
      .relayDelegate({
        signedDelegate,
        beforeBroadcast: (txHash) =>
          withScope({ organizationId: send.organizationId }, (tx) =>
            query(() =>
              tx
                .update(companyWalletSends)
                .set({
                  relayTxHashes: sql`array_append(${companyWalletSends.relayTxHashes}, ${txHash})`,
                })
                .where(
                  and(
                    eq(companyWalletSends.id, send.id),
                    eq(companyWalletSends.status, "signed"),
                  ),
                )
                .returning({ id: companyWalletSends.id }),
            ),
          ).pipe(
            Effect.flatMap(([recorded]) =>
              recorded
                ? Effect.void
                : Effect.fail(
                    new SendOutcomeUnknown({
                      message: `Send ${send.id} was settled while it was being relayed`,
                      cause: null,
                    }),
                  ),
            ),
          ),
      })
      .pipe(Effect.either);
    if (relayed._tag === "Right") {
      yield* relayer.awaitOutcome(relayed.right.txHash);
    } else {
      console.warn(
        `[wallet] relaying send ${send.id} failed; reading its outcome from the chain`,
        relayed.left.message,
      );
    }
    return yield* settle(send);
  }).pipe(unknownOnceSigned(send));
}

function conclude(
  send: CompanyWalletSend,
): Effect.Effect<CompanyWalletSendReceipt, SendRefused | SendOutcomeUnknown> {
  switch (send.status) {
    case "executed":
      return send.txHash !== null && send.blockHeight !== null
        ? Effect.succeed({
            sendId: send.id,
            txHash: send.txHash,
            blockHeight: send.blockHeight,
          })
        : Effect.dieMessage("an executed send has no transaction");
    case "failed":
    case "expired":
    case "refused":
      return Effect.fail(
        refused(`${send.failure ?? `Send ${send.status}`}. Nothing was sent.`, {
          status: 409,
        }),
      );
    case "reserved":
    case "signed":
      return Effect.fail(
        new SendOutcomeUnknown({
          message: `Send ${send.id} was relayed and isn't final yet. Call again with the same key to find out.`,
          cause: null,
        }),
      );
  }
}

function send(
  request: TransferRequest,
): Effect.Effect<
  CompanyWalletSendReceipt,
  CompanyWalletSendError,
  CompanyWalletSendDeps
> {
  return Effect.gen(function* () {
    if (normaliseNearAccountId(request.to) !== request.to) {
      return yield* Effect.fail(
        refused(`Not a NEAR account ID: ${request.to}`),
      );
    }
    if (request.amount <= 0n) {
      return yield* Effect.fail(refused("The amount must be positive"));
    }
    const wallet = yield* sendingWallet(request.organizationId);

    const earlier = yield* liveSendFor(request.organizationId, request.sendKey);
    const refreshed = earlier === null ? null : yield* refresh(earlier);
    let current =
      refreshed === null || refreshed.status === "expired"
        ? yield* reserve(wallet, request)
        : refreshed;

    if (
      current.kind !== request.kind ||
      current.receiverAccountId !== request.to ||
      current.usdcAmount !== request.amount ||
      current.msg !== request.msg
    ) {
      return yield* Effect.fail(
        refused(
          `Send key ${request.sendKey} already names a different transfer`,
          { status: 409 },
        ),
      );
    }

    if (current.status === "reserved") current = yield* sign(wallet, current);
    if (current.status === "signed") current = yield* relayAndSettle(current);
    return yield* conclude(current);
  });
}

/**
 * Sends USDC from a company wallet to a NEAR account, through the gas
 * relayer, following "Sending from a company wallet" in
 * docs/decisions/near-main-chain.md:
 *
 * 1. the send takes the wallet's next nonce and an expiry about two minutes
 *    ahead, saved before anything is signed;
 * 2. the cap is checked, Privy signs, and the signed bytes are saved;
 * 3. only then is it relayed, and every relayer transaction's hash is
 *    saved before it is broadcast;
 * 4. it is final once the chain shows it ran, or shows after its expiry
 *    that it never did.
 *
 * Calling again with the same key is always safe and is how an unclear send
 * is followed up: a send that ran returns the same receipt, one in flight
 * has its saved bytes relayed again, and a new one is built only after the
 * last is known never to have run.
 *
 * - `SendRefused`: nothing moved and nothing will. Over the cap it has
 *   `policyViolation` set, as a Privy policy refusal does on Base.
 * - `SendOutcomeUnknown`: signed, and the chain doesn't yet say. It may
 *   have moved: never pay the same thing another way.
 * - `CompanyWalletBusy`: another send from this wallet is in flight.
 * - anything else: it failed before signing, so nothing moved.
 */
export function sendUsdcFromCompanyWallet(
  input: CompanyWalletSendInput,
): Effect.Effect<
  CompanyWalletSendReceipt,
  CompanyWalletSendError,
  CompanyWalletSendDeps
> {
  return send({ ...input, kind: "transfer", msg: null });
}

/**
 * `sendUsdcFromCompanyWallet`, as an `ft_transfer_call` carrying `msg`: for
 * a deposit address that has to be told what a transfer is for, such as a
 * 1Click quote's. It counts as sent only if the receiver kept all of it.
 */
export function sendUsdcFromCompanyWalletWithCall(
  input: CompanyWalletSendInput & { readonly msg: string },
): Effect.Effect<
  CompanyWalletSendReceipt,
  CompanyWalletSendError,
  CompanyWalletSendDeps
> {
  return send({ ...input, kind: "transfer_call" });
}

/**
 * The latest send saved under a key, brought up to date with the chain, or
 * null if there never was one. For following up an unclear send without
 * relaying or building anything.
 */
export function settleCompanyWalletSend(input: {
  readonly organizationId: string;
  readonly sendKey: string;
}): Effect.Effect<
  CompanyWalletSend | null,
  SendOutcomeUnknown | NearRpcError | DatabaseError,
  DatabaseService | NearRpc | NearRelayer | NearChain
> {
  return withScope({ organizationId: input.organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(companyWalletSends)
        .where(
          and(
            eq(companyWalletSends.organizationId, input.organizationId),
            eq(companyWalletSends.sendKey, input.sendKey),
          ),
        )
        .orderBy(desc(companyWalletSends.createdAt))
        .limit(1),
    ),
  ).pipe(
    Effect.flatMap(([latest]) =>
      latest === undefined ? Effect.succeed(null) : refresh(latest),
    ),
  );
}
