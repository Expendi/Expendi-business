import type { SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Option } from "effect";

import type { TreasuryEarnAction } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { Snapshot, Step } from "./move-state.js";
import type { ReturnDeps } from "./return-engine.js";
import { treasuryEarnActions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { usdcTransfersIn } from "../chain/base.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import {
  advanceEarnAction,
  endMove,
  idle,
  moved,
  needsReview,
  treasuryWalletOf,
} from "./move-state.js";
import { stepReturn } from "./return-engine.js";
import { earnVaultId } from "./turn-on.js";

/**
 * Moving the vault's USDC back to the company wallet
 * (docs/work/treasury/spec.md, sections 4 and 11), one step at a time, each
 * safe to run twice:
 *
 * 1. the withdrawal's action row is saved, then Privy Earn is called once
 *    with its reference (`advanceEarnAction`), and polled;
 * 2. what the withdrawal delivered to the Treasury wallet is read from its
 *    own transaction's USDC `Transfer` logs and saved once. A vault may fill
 *    a withdrawal in part, and the Treasury wallet may hold USDC someone
 *    else sent: neither is the wallet's balance's business;
 * 3. exactly that is sent back in parts (`stepReturn`);
 * 4. the move completes when the deposit watcher has credited every part.
 */

/** How long a withdrawal's transaction may take to show before a person looks. */
const TRANSACTION_WAIT_MS = 30 * 60_000;

function startWithdrawal(snap: Snapshot) {
  const { move, wallet } = snap;
  const { organizationId } = move;
  return Effect.gen(function* () {
    const privy = yield* PrivyWallets;
    const treasury = treasuryWalletOf(wallet);
    const vault = yield* earnVaultId;
    if (treasury === null || Option.isNone(vault)) {
      return yield* endMove(
        snap,
        "failed",
        "Treasury isn't available, so nothing was withdrawn.",
      );
    }
    let amount = move.requestedUsdc;
    if (move.isAll) {
      const position = yield* privy
        .vaultPosition({
          privyWalletId: treasury.privyWalletId,
          vaultId: vault.value,
        })
        .pipe(Effect.either);
      if (position._tag === "Left") return idle(move);
      amount = position.right.assetsInVault;
      if (amount <= 0n) {
        return yield* endMove(
          snap,
          "failed",
          "Treasury holds nothing to move. Nothing moved.",
        );
      }
    }
    const id = randomUUID();
    const [saved] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .insert(treasuryEarnActions)
          .values({
            id,
            organizationId,
            treasuryMoveId: move.id,
            kind: "withdraw",
            referenceId: `tr-${id}-1`,
            rawAmount: amount,
          })
          .onConflictDoNothing()
          .returning(),
      ),
    );
    return saved ? moved(move) : idle(move);
  });
}

/** An action that is succeeded but not yet readable: wait, then a person looks. */
function waitFor(snap: Snapshot, action: TreasuryEarnAction, what: string) {
  const since = (action.settledAt ?? action.updatedAt).getTime();
  return Date.now() - since > TRANSACTION_WAIT_MS
    ? needsReview(
        snap,
        `Privy reports the withdrawal ${action.referenceId} succeeded, but ${what} for 30 minutes. Look the reference up in Privy and check the Treasury wallet before doing anything.`,
      )
    : Effect.succeed(idle(snap.move));
}

const save = (
  snap: Snapshot,
  action: TreasuryEarnAction,
  changes: Partial<typeof treasuryEarnActions.$inferInsert>,
  when: SQL,
) =>
  withScope({ organizationId: snap.move.organizationId }, (tx) =>
    query(() =>
      tx
        .update(treasuryEarnActions)
        .set(changes)
        .where(and(eq(treasuryEarnActions.id, action.id), when))
        .returning({ id: treasuryEarnActions.id }),
    ),
  ).pipe(Effect.map((rows) => rows.length > 0));

/**
 * What a succeeded withdrawal put in the Treasury wallet: the USDC
 * `Transfer` logs to that wallet in the receipt of the step's own
 * transaction, saved once. Never more than was asked.
 */
function readDelivery(snap: Snapshot, withdrawal: TreasuryEarnAction) {
  const { move, wallet } = snap;
  return Effect.gen(function* () {
    const treasury = treasuryWalletOf(wallet);
    if (treasury === null) {
      return yield* needsReview(
        snap,
        "Treasury's wallet isn't set up, so what the withdrawal delivered can't be read.",
      );
    }
    let txHash = withdrawal.txHash;
    if (txHash === null) {
      const privy = yield* PrivyWallets;
      if (withdrawal.privyActionId === null) return idle(move);
      const read = yield* privy
        .getWalletAction({
          privyWalletId: treasury.privyWalletId,
          actionId: withdrawal.privyActionId,
        })
        .pipe(Effect.either);
      txHash = read._tag === "Right" ? read.right.txHash : null;
      if (txHash === null) {
        return yield* waitFor(snap, withdrawal, "gave no transaction hash");
      }
      yield* save(
        snap,
        withdrawal,
        { txHash },
        isNull(treasuryEarnActions.txHash),
      );
      return moved(move);
    }

    const rpc = yield* BaseRpc;
    const receipt = yield* rpc
      .getTransactionReceipt(txHash)
      .pipe(Effect.either);
    if (receipt._tag === "Left") return idle(move);
    if (receipt.right === null) {
      return yield* waitFor(
        snap,
        withdrawal,
        `its transaction ${txHash} hasn't shown on Base`,
      );
    }
    if (receipt.right.status !== "0x1") {
      return yield* needsReview(
        snap,
        `Privy reports the withdrawal ${withdrawal.referenceId} succeeded but its transaction ${txHash} reverted on Base. Check the Treasury wallet and the vault before doing anything.`,
      );
    }
    const arrived = usdcTransfersIn(receipt.right)
      .filter((transfer) => transfer.to === treasury.address.toLowerCase())
      .reduce((sum, transfer) => sum + transfer.amount, 0n);
    if (arrived <= 0n) {
      return yield* needsReview(
        snap,
        `The withdrawal ${withdrawal.referenceId} succeeded but its transaction ${txHash} shows no USDC reaching the Treasury wallet. Check the wallet and the vault before doing anything.`,
      );
    }
    const delivered =
      arrived < withdrawal.rawAmount ? arrived : withdrawal.rawAmount;
    const wrote = yield* save(
      snap,
      withdrawal,
      { deliveredUsdc: delivered },
      isNull(treasuryEarnActions.deliveredUsdc),
    );
    return wrote ? moved(move) : idle(move);
  });
}

const finishMove = (snap: Snapshot) => () => endMove(snap, "completed", null);

/**
 * One step of an open move to the wallet: the next thing the saved rows say
 * hasn't been done.
 */
export function stepToWallet(
  snap: Snapshot,
): Effect.Effect<Step, DatabaseError, ReturnDeps> {
  return Effect.gen(function* () {
    const withdrawal = snap.actions.find(
      (action) => action.kind === "withdraw",
    );
    if (withdrawal === undefined) return yield* startWithdrawal(snap);
    switch (withdrawal.status) {
      case "saved":
      case "pending":
        return yield* advanceEarnAction(snap, withdrawal);
      case "rejected":
        return yield* endMove(
          snap,
          "failed",
          `Privy rejected the withdrawal (${withdrawal.failure ?? "no reason given"}). Nothing moved: the USDC is still in Treasury.`,
        );
      case "failed":
        return yield* endMove(
          snap,
          "failed",
          `The withdrawal reverted on Base (${withdrawal.failure ?? "no reason given"}). The USDC is still in Treasury.`,
        );
      case "succeeded":
        if (withdrawal.deliveredUsdc === null) {
          return yield* readDelivery(snap, withdrawal);
        }
        return yield* stepReturn(
          snap,
          withdrawal.deliveredUsdc,
          finishMove(snap),
        );
    }
  });
}
