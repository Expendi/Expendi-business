import { Cause, Effect, Exit, Option } from "effect";
import {
  actions,
  createTransaction,
  DelegateAction,
  KeyPair,
  KeyPairSigner,
} from "near-api-js";
import { beforeEach, describe, expect, it } from "vitest";

import { usdcTransferAction } from "../../services/chain/near.js";
import { makeFakePrivyWallets } from "../helpers/fakes.js";
import {
  makeFakeNearRpc,
  nearRelayerOnFakeChain,
  randomNearAccount,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";

let privy: ReturnType<typeof makeFakePrivyWallets>;
let chain: ReturnType<typeof makeFakeNearRpc>;
let relayer: ReturnType<typeof nearRelayerOnFakeChain>;

beforeEach(() => {
  privy = makeFakePrivyWallets();
  chain = makeFakeNearRpc();
  relayer = nearRelayerOnFakeChain(privy.state, chain);
});

const activate = (accountId: string) =>
  Effect.runPromiseExit(relayer.service.activateAccount(accountId));

const failureMessage = (
  exit: Exit.Exit<unknown, string | { readonly message: string }>,
) => {
  if (Exit.isSuccess(exit)) return null;
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  if (failure === null) return "defect";
  return typeof failure === "string" ? failure : failure.message;
};

/** A delegate action signed by a fresh company account that exists on chain. */
async function signedDelegateFor(receiverId: string) {
  const keyPair = KeyPair.fromRandom("ed25519");
  const senderId = Buffer.from(keyPair.getPublicKey().data).toString("hex");
  chain.state.fundWithUsdc(senderId, 10_000_000n);
  const { signedDelegate } = await new KeyPairSigner(
    keyPair,
  ).signDelegateAction(
    new DelegateAction({
      senderId,
      receiverId,
      actions: [usdcTransferAction("payee.near", 1_000_000n)],
      nonce: 1n,
      maxBlockHeight: chain.state.height + 100n,
      publicKey: keyPair.getPublicKey(),
    }),
  );
  return signedDelegate;
}

describe("NearRelayer.activateAccount", () => {
  it("creates the account on chain and registers it with USDC", async () => {
    // #given
    const account = randomNearAccount();

    // #when
    const exit = await activate(account);

    // #then
    expect({
      succeeded: Exit.isSuccess(exit),
      exists: chain.state.accounts.has(account),
      registered: chain.state.registered.has(account),
      transactions: chain.state.broadcasts.length,
    }).toEqual({
      succeeded: true,
      exists: true,
      registered: true,
      transactions: 2,
    });
  });

  it("does nothing for an account that is already usable", async () => {
    // #given
    const account = randomNearAccount();
    await activate(account);
    const before = chain.state.broadcasts.length;

    // #when
    const exit = await activate(account);

    // #then
    expect({
      succeeded: Exit.isSuccess(exit),
      newTransactions: chain.state.broadcasts.length - before,
    }).toEqual({ succeeded: true, newTransactions: 0 });
  });

  it("only registers an account that already exists on chain", async () => {
    // #given
    const account = randomNearAccount();
    chain.state.createAccount(account);

    // #when
    await activate(account);

    // #then
    expect({
      registered: chain.state.registered.has(account),
      transactions: chain.state.broadcasts.length,
    }).toEqual({ registered: true, transactions: 1 });
  });

  it("fails while its transaction isn't final, and finishes on the next call without creating the account twice", async () => {
    // #given the transfer that creates the account runs, but isn't final yet
    const account = randomNearAccount();
    chain.state.nextBroadcasts("withhold");
    const first = await activate(account);
    chain.state.release();

    // #when
    const second = await activate(account);

    // #then
    expect({
      firstFailed: Exit.isFailure(first),
      secondSucceeded: Exit.isSuccess(second),
      registered: chain.state.registered.has(account),
      transactions: chain.state.broadcasts.length,
    }).toEqual({
      firstFailed: true,
      secondSucceeded: true,
      registered: true,
      transactions: 2,
    });
  });

  it("fails when the chain never ran its transaction", async () => {
    // #given
    const account = randomNearAccount();
    chain.state.nextBroadcasts("drop");

    // #when
    const exit = await activate(account);

    // #then
    expect({
      failed: Exit.isFailure(exit),
      exists: chain.state.accounts.has(account),
    }).toEqual({ failed: true, exists: false });
  });

  it("refuses an account it couldn't sign for later", async () => {
    // #when
    const exit = await activate("company.near");

    // #then
    expect({
      message: failureMessage(exit),
      transactions: chain.state.broadcasts.length,
    }).toEqual({
      message: "Not an implicit NEAR account: company.near",
      transactions: 0,
    });
  });

  it("gives every transaction its own nonce when activations run at once", async () => {
    // #given
    const accounts = Array.from({ length: 5 }, randomNearAccount);

    // #when
    const exits = await Promise.all(accounts.map(activate));

    // #then a reused nonce would have been thrown out by the chain
    expect({
      succeeded: exits.filter(Exit.isSuccess).length,
      registered: accounts.filter((account) =>
        chain.state.registered.has(account),
      ).length,
      transactions: chain.state.broadcasts.length,
      relayerNonce: chain.state.nonceOf(relayer.accountId),
    }).toEqual({
      succeeded: 5,
      registered: 5,
      transactions: 10,
      relayerNonce: 10n,
    });
  });

  it("says so when the relayer's own account isn't on chain", async () => {
    // #given
    chain.state.accounts.delete(relayer.accountId);

    // #when
    const exit = await activate(randomNearAccount());

    // #then
    expect(failureMessage(exit)).toContain("doesn't exist on chain yet");
  });
});

describe("NearRelayer.relayDelegate", () => {
  it("pays for a company account's signed USDC transfer", async () => {
    // #given
    chain.state.fundWithUsdc("payee.near", 0n);
    const signedDelegate = await signedDelegateFor(TEST_USDC_CONTRACT);

    // #when
    const relayed = await Effect.runPromise(
      relayer.service.relayDelegate({
        signedDelegate,
        beforeBroadcast: () => Effect.void,
      }),
    );

    // #then
    const outcome = chain.state.outcomes.get(relayed.txHash);
    expect({
      signer: outcome?.signerId,
      receiver: outcome?.receiverId,
      succeeded: outcome?.succeeded,
      payeeBalance: chain.state.usdcBalanceOf("payee.near"),
    }).toEqual({
      signer: relayer.accountId,
      receiver: signedDelegate.delegateAction.senderId,
      succeeded: true,
      payeeBalance: 1_000_000n,
    });
  });

  it("hands over the transaction's hash before broadcasting it", async () => {
    // #given
    const signedDelegate = await signedDelegateFor(TEST_USDC_CONTRACT);
    const seen: { txHash: string; alreadyBroadcast: boolean }[] = [];

    // #when
    const relayed = await Effect.runPromise(
      relayer.service.relayDelegate({
        signedDelegate,
        beforeBroadcast: (txHash) =>
          Effect.sync(() => {
            seen.push({
              txHash,
              alreadyBroadcast: chain.state.broadcasts.includes(txHash),
            });
          }),
      }),
    );

    // #then
    expect({ seen, broadcasts: chain.state.broadcasts }).toEqual({
      seen: [{ txHash: relayed.txHash, alreadyBroadcast: false }],
      broadcasts: [relayed.txHash],
    });
  });

  it("broadcasts nothing when the hash couldn't be saved", async () => {
    // #given
    const signedDelegate = await signedDelegateFor(TEST_USDC_CONTRACT);

    // #when
    const exit = await Effect.runPromiseExit(
      relayer.service.relayDelegate({
        signedDelegate,
        beforeBroadcast: () => Effect.fail("could not save" as const),
      }),
    );

    // #then
    expect({
      failed: Exit.isFailure(exit),
      broadcasts: chain.state.broadcasts.length,
    }).toEqual({ failed: true, broadcasts: 0 });
  });

  it("refuses a delegate action for any contract but USDC", async () => {
    // #given
    const signedDelegate = await signedDelegateFor("evil.near");

    // #when
    const exit = await Effect.runPromiseExit(
      relayer.service.relayDelegate({
        signedDelegate,
        beforeBroadcast: () => Effect.void,
      }),
    );

    // #then
    expect({
      failed: Exit.isFailure(exit),
      broadcasts: chain.state.broadcasts.length,
    }).toEqual({ failed: true, broadcasts: 0 });
  });

  it("is null from awaitOutcome while a relayed transaction isn't final", async () => {
    // #given
    const signedDelegate = await signedDelegateFor(TEST_USDC_CONTRACT);
    chain.state.nextBroadcasts("withhold");
    const relayed = await Effect.runPromise(
      relayer.service.relayDelegate({
        signedDelegate,
        beforeBroadcast: () => Effect.void,
      }),
    );

    // #when
    const pending = await Effect.runPromise(
      relayer.service.awaitOutcome(relayed.txHash),
    );
    chain.state.release();
    const final = await Effect.runPromise(
      relayer.service.awaitOutcome(relayed.txHash),
    );

    // #then
    expect({ pending, final: final?.txHash }).toEqual({
      pending: null,
      final: relayed.txHash,
    });
  });
});

describe("NearRelayer.registerUsdcAccount", () => {
  const register = (
    accountId: string,
    beforeBroadcast: (txHash: string) => Effect.Effect<void, string> = () =>
      Effect.void,
  ) =>
    Effect.runPromiseExit(
      relayer.service.registerUsdcAccount({ accountId, beforeBroadcast }),
    );

  it("registers an account with the USDC contract, in one transaction to it", async () => {
    // #given an account the USDC contract doesn't know
    const account = randomNearAccount();
    chain.state.createAccount(account);

    // #when
    const exit = await register(account);

    // #then
    const [txHash] = chain.state.broadcasts;
    expect({
      result: Exit.isSuccess(exit) ? exit.value : null,
      registered: chain.state.registered.has(account),
      transactions: chain.state.broadcasts.length,
      sentTo: chain.state.outcomes.get(txHash ?? "")?.receiverId,
    }).toEqual({
      result: { txHash },
      registered: true,
      transactions: 1,
      sentTo: TEST_USDC_CONTRACT,
    });
  });

  it("does nothing, and pays nothing, for an account already registered", async () => {
    // #given an account registered by an earlier call
    const account = randomNearAccount();
    chain.state.createAccount(account);
    await register(account);

    // #when it is registered again
    const exit = await register(account);

    // #then no second transaction was sent
    expect({
      result: Exit.isSuccess(exit) ? exit.value : null,
      transactions: chain.state.broadcasts.length,
    }).toEqual({ result: { txHash: null }, transactions: 1 });
  });

  it("hands over the transaction's hash before broadcasting it", async () => {
    // #given
    const account = randomNearAccount();
    chain.state.createAccount(account);
    const seen: { txHash: string; alreadyBroadcast: boolean }[] = [];

    // #when
    await register(account, (txHash) =>
      Effect.sync(() => {
        seen.push({
          txHash,
          alreadyBroadcast: chain.state.broadcasts.includes(txHash),
        });
      }),
    );

    // #then
    expect({ seen, broadcasts: chain.state.broadcasts }).toEqual({
      seen: [{ txHash: chain.state.broadcasts[0], alreadyBroadcast: false }],
      broadcasts: [seen[0]?.txHash],
    });
  });

  it("broadcasts nothing when the hash couldn't be saved", async () => {
    // #given
    const account = randomNearAccount();
    chain.state.createAccount(account);

    // #when
    const exit = await register(account, () => Effect.fail("could not save"));

    // #then
    expect({
      failed: Exit.isFailure(exit),
      registered: chain.state.registered.has(account),
      broadcasts: chain.state.broadcasts.length,
    }).toEqual({ failed: true, registered: false, broadcasts: 0 });
  });

  it("fails until the chain shows the account registered", async () => {
    // #given a registration the chain hasn't reported yet
    const account = randomNearAccount();
    chain.state.createAccount(account);
    chain.state.nextBroadcasts("drop");

    // #when
    const exit = await register(account);

    // #then
    expect({
      message: failureMessage(exit),
      registered: chain.state.registered.has(account),
    }).toEqual({
      message: `The chain doesn't show ${account} as registered with USDC yet`,
      registered: false,
    });
  });

  it("refuses what isn't a NEAR account, without sending anything", async () => {
    // #when
    const exit = await register("Not An Account");

    // #then
    expect({
      message: failureMessage(exit),
      broadcasts: chain.state.broadcasts.length,
    }).toEqual({
      message: "Not a NEAR account ID: Not An Account",
      broadcasts: 0,
    });
  });
});

describe("NearRelayer.sendUsdc", () => {
  const COVER = 16_435n;

  const send = (
    to: string,
    amount: bigint,
    beforeBroadcast: (txHash: string) => Effect.Effect<void, string> = () =>
      Effect.void,
  ) =>
    Effect.runPromiseExit(
      relayer.service.sendUsdc({ to, amount, beforeBroadcast }),
    );

  /** A company account that can hold USDC, and a relayer that holds some. */
  function fundedPair(): string {
    const company = randomNearAccount();
    chain.state.fundWithUsdc(company, 0n);
    chain.state.fundWithUsdc(relayer.accountId, 1_000_000n);
    return company;
  }

  it("moves the relayer's own USDC with one transfer on the USDC contract", async () => {
    // #given
    const company = fundedPair();

    // #when
    const exit = await send(company, COVER);

    // #then
    const [txHash] = chain.state.broadcasts;
    const outcome = chain.state.outcomes.get(txHash ?? "");
    expect({
      result: Exit.isSuccess(exit) ? exit.value : null,
      companyHolds: chain.state.usdcBalanceOf(company),
      relayerHolds: chain.state.usdcBalanceOf(relayer.accountId),
      signedBy: outcome?.signerId,
      sentTo: outcome?.receiverId,
      succeeded: outcome?.succeeded,
    }).toEqual({
      result: { txHash },
      companyHolds: COVER,
      relayerHolds: 1_000_000n - COVER,
      signedBy: relayer.accountId,
      sentTo: TEST_USDC_CONTRACT,
      succeeded: true,
    });
  });

  it("hands over the transaction's hash before broadcasting it", async () => {
    // #given
    const company = fundedPair();
    const seen: { txHash: string; alreadyBroadcast: boolean }[] = [];

    // #when
    await send(company, COVER, (txHash) =>
      Effect.sync(() => {
        seen.push({
          txHash,
          alreadyBroadcast: chain.state.broadcasts.includes(txHash),
        });
      }),
    );

    // #then
    expect({ seen, broadcasts: chain.state.broadcasts }).toEqual({
      seen: [{ txHash: chain.state.broadcasts[0], alreadyBroadcast: false }],
      broadcasts: [seen[0]?.txHash],
    });
  });

  it("sends nothing when the hash couldn't be saved", async () => {
    // #given
    const company = fundedPair();

    // #when
    const exit = await send(company, COVER, () =>
      Effect.fail("could not save"),
    );

    // #then
    expect({
      failed: Exit.isFailure(exit),
      companyHolds: chain.state.usdcBalanceOf(company),
      broadcasts: chain.state.broadcasts.length,
    }).toEqual({ failed: true, companyHolds: 0n, broadcasts: 0 });
  });

  it("builds a new transaction on every call, so its caller must keep the hash", async () => {
    // #given
    const company = fundedPair();

    // #when it is called twice with the same arguments
    await send(company, COVER);
    await send(company, COVER);

    // #then two different transactions paid twice: the relayer itself
    // remembers nothing, the saved hash is what stops a second call
    expect({
      transactions: new Set(chain.state.broadcasts).size,
      companyHolds: chain.state.usdcBalanceOf(company),
    }).toEqual({ transactions: 2, companyHolds: 2n * COVER });
  });

  it("reports a transfer the chain ran without moving USDC as failed", async () => {
    // #given a relayer that holds no USDC
    const company = randomNearAccount();
    chain.state.fundWithUsdc(company, 0n);
    chain.state.fundWithUsdc(relayer.accountId, 0n);

    // #when
    const exit = await send(company, COVER);
    const outcome = Exit.isSuccess(exit)
      ? await Effect.runPromise(relayer.service.awaitOutcome(exit.value.txHash))
      : null;

    // #then
    expect({
      succeeded: outcome?.succeeded,
      companyHolds: chain.state.usdcBalanceOf(company),
    }).toEqual({ succeeded: false, companyHolds: 0n });
  });

  it.each([
    ["a recipient that isn't a NEAR account", "Not An Account", COVER],
    ["an amount of zero", "payee.near", 0n],
    ["a negative amount", "payee.near", -1n],
  ] as const)("refuses %s, without sending anything", async (_, to, amount) => {
    // #given
    chain.state.fundWithUsdc(relayer.accountId, 1_000_000n);

    // #when
    const exit = await send(to, amount);

    // #then
    expect({
      message: failureMessage(exit),
      broadcasts: chain.state.broadcasts.length,
    }).toEqual({
      message: `The gas relayer can't send ${amount} USDC base units to ${to}`,
      broadcasts: 0,
    });
  });
});

describe("the fake chain", () => {
  it("runs a delegate action's nonce only once", async () => {
    // #given
    chain.state.fundWithUsdc("payee.near", 0n);
    const signedDelegate = await signedDelegateFor(TEST_USDC_CONTRACT);
    const relay = () =>
      Effect.runPromise(
        relayer.service.relayDelegate({
          signedDelegate,
          beforeBroadcast: () => Effect.void,
        }),
      );
    await relay();

    // #when
    const again = await relay();

    // #then
    expect({
      secondRan: chain.state.outcomes.get(again.txHash)?.succeeded,
      payeeBalance: chain.state.usdcBalanceOf("payee.near"),
    }).toEqual({ secondRan: false, payeeBalance: 1_000_000n });
  });

  it("throws out a transaction signed by a key that isn't its signer's", async () => {
    // #given a stranger signs as the relayer, correctly, with their own key
    const stranger = KeyPair.fromRandom("ed25519");
    const account = randomNearAccount();
    const { signedTransaction } = await new KeyPairSigner(
      stranger,
    ).signTransaction(
      createTransaction(
        relayer.accountId,
        stranger.getPublicKey(),
        account,
        1n,
        [actions.transfer(1n)],
        new Uint8Array(32),
      ),
    );

    // #when
    await Effect.runPromise(
      chain.service.broadcast(signedTransaction.encode()),
    );

    // #then
    expect(chain.state.accounts.has(account)).toBe(false);
  });
});
