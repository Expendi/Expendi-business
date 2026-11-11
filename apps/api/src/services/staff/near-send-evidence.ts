import { and, desc, eq } from "drizzle-orm";
import { Config, Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { CompanyWalletSend } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type {
  NearTransactionOutcome,
  NearUsdcTransfer,
} from "../chain/near.js";
import { companyWalletSends } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { ServiceUnavailable } from "../../errors.js";
import { NearRpc } from "../chain/near-rpc.js";
import {
  isImplicitNearAccount,
  NearChain,
  nearUsdcTransfersIn,
} from "../chain/near.js";
import { payoutSendKey } from "../payout/guards.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * What staff can see of a NEAR payout's company wallet sends (spec §6.15):
 * every send saved for the payout, the relayer transactions that carried
 * it, and what the chain says each one did. Read-only, and deliberately
 * apart from the code that signs and relays: it reads the saved rows and
 * the chain itself, so nothing the admin app can reach is able to send.
 */

/**
 * How far past a send's expiry the final block must be before staff may
 * close the send as never run: about ten minutes. A transaction included
 * before the expiry is final long before this, and one included after it
 * can't run the send any more.
 */
export const SEND_RELEASE_MARGIN_BLOCKS = 600n;

export interface RelayedTransaction {
  /** Base58: never lowercase it. */
  readonly txHash: string;
  /** Null while the chain doesn't show the transaction as final. */
  readonly outcome: {
    readonly blockHeight: bigint;
    readonly succeeded: boolean;
    /** Whether the chain accepted and ran the send inside this transaction. */
    readonly sendRan: boolean;
    /** Every USDC transfer the transaction made. */
    readonly usdcTransfers: readonly NearUsdcTransfer[];
  } | null;
}

export interface NearSendEvidence {
  readonly send: CompanyWalletSend;
  readonly transactions: readonly RelayedTransaction[];
}

export interface NearEvidence {
  /** The latest block that can no longer be reverted, read just now. */
  readonly finalBlockHeight: bigint;
  /** Newest first. */
  readonly sends: readonly NearSendEvidence[];
}

const unavailable = (what: string) =>
  new ServiceUnavailable({
    message: `${what} Nothing was changed; try again shortly.`,
  });

/**
 * The gas relayer's account, which NEAR needs to look one of its
 * transactions up. Read from the same setting the relayer itself uses,
 * rather than from the relayer, which can sign.
 */
const relayerAccountId = Config.string("NEAR_RELAYER_ACCOUNT_ID").pipe(
  Effect.filterOrFail(isImplicitNearAccount, () => null),
  Effect.mapError(() =>
    unavailable(
      "The gas relayer's account isn't configured, so its transactions can't be looked up.",
    ),
  ),
);

function sendRan(
  outcome: NearTransactionOutcome,
  send: CompanyWalletSend,
): boolean {
  const ownReceipt = outcome.receipts.find(
    (receipt) => receipt.receiptId === outcome.ownReceiptId,
  );
  return (
    outcome.receiverId === send.senderAccountId &&
    ownReceipt?.executorId === send.senderAccountId &&
    ownReceipt.succeeded
  );
}

/** Every send saved for a payout, with what the chain shows of each. */
export function gatherNearSends(
  organizationId: string,
  payoutId: string,
): Effect.Effect<
  NearEvidence,
  ServiceUnavailable | DatabaseError,
  DatabaseService | NearRpc | NearChain
> {
  return gatherNearSendsByKey(organizationId, payoutSendKey(payoutId));
}

/**
 * Every send saved under one send key (a payout's, or a NEAR Intents
 * quote's deposit), with what the chain shows of each.
 */
export function gatherNearSendsByKey(
  organizationId: string,
  sendKey: string,
): Effect.Effect<
  NearEvidence,
  ServiceUnavailable | DatabaseError,
  DatabaseService | NearRpc | NearChain
> {
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const chain = yield* NearChain;
    const sends = yield* withStaffReadScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(companyWalletSends)
          .where(
            and(
              eq(companyWalletSends.organizationId, organizationId),
              eq(companyWalletSends.sendKey, sendKey),
            ),
          )
          .orderBy(desc(companyWalletSends.createdAt)),
      ),
    );
    if (sends.length === 0) return { finalBlockHeight: 0n, sends: [] };

    const signer = yield* relayerAccountId;
    return yield* Effect.gen(function* () {
      const final = yield* rpc.finalBlock();
      const evidence: NearSendEvidence[] = [];
      for (const send of sends) {
        const transactions: RelayedTransaction[] = [];
        for (const txHash of send.relayTxHashes) {
          const outcome = yield* rpc.transactionOutcome(txHash, signer);
          transactions.push({
            txHash,
            outcome: outcome && {
              blockHeight: outcome.blockHeight,
              succeeded: outcome.succeeded,
              sendRan: sendRan(outcome, send),
              usdcTransfers: nearUsdcTransfersIn(outcome, chain.usdcContractId),
            },
          });
        }
        evidence.push({ send, transactions });
      }
      return { finalBlockHeight: final.height, sends: evidence };
    }).pipe(
      Effect.mapError((error) =>
        unavailable(
          `Couldn't read the company wallet's sends from NEAR (${error.message}).`,
        ),
      ),
    );
  });
}

export interface CompanyWalletSendView {
  readonly id: string;
  readonly status: CompanyWalletSend["status"];
  readonly kind: CompanyWalletSend["kind"];
  readonly senderAccountId: string;
  readonly receiverAccountId: string;
  readonly usdcAmount: bigint;
  readonly nonce: bigint;
  /** The last block the chain would run it in. */
  readonly maxBlockHeight: bigint;
  /** The relayer transaction the chain ran it in, once known. */
  readonly txHash: string | null;
  readonly blockHeight: bigint | null;
  readonly failure: string | null;
  readonly createdAt: string;
  /** Every relayer transaction that carried it, in the order they were sent. */
  readonly transactions: readonly {
    readonly txHash: string;
    readonly final: boolean;
    readonly blockHeight: bigint | null;
    readonly succeeded: boolean | null;
    readonly sendRan: boolean | null;
    readonly usdcTransfers: readonly {
      readonly from: string;
      readonly to: string;
      readonly usdcAmount: bigint;
      readonly logIndex: number;
    }[];
  }[];
}

export function companyWalletSendView({
  send,
  transactions,
}: NearSendEvidence): CompanyWalletSendView {
  return {
    id: send.id,
    status: send.status,
    kind: send.kind,
    senderAccountId: send.senderAccountId,
    receiverAccountId: send.receiverAccountId,
    usdcAmount: send.usdcAmount,
    nonce: send.nonce,
    maxBlockHeight: send.maxBlockHeight,
    txHash: send.txHash,
    blockHeight: send.blockHeight,
    failure: send.failure,
    createdAt: send.createdAt.toISOString(),
    transactions: transactions.map(({ txHash, outcome }) => ({
      txHash,
      final: outcome !== null,
      blockHeight: outcome?.blockHeight ?? null,
      succeeded: outcome?.succeeded ?? null,
      sendRan: outcome?.sendRan ?? null,
      usdcTransfers: (outcome?.usdcTransfers ?? []).map((transfer) => ({
        from: transfer.from,
        to: transfer.to,
        usdcAmount: transfer.amount,
        logIndex: transfer.logIndex,
      })),
    })),
  };
}
