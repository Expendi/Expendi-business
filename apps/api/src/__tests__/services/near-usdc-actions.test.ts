import type { Action } from "near-api-js";
import { describe, expect, it } from "vitest";

import {
  USDC_STORAGE_DEPOSIT_YOCTO,
  usdcStorageDepositAction,
  usdcTransferAction,
  usdcTransferCallAction,
} from "../../services/chain/near.js";
import { randomNearAccount } from "../helpers/near.js";

/** The function call an action makes, with its JSON arguments decoded. */
function callIn(action: Action) {
  const call = action.functionCall;
  if (!call) throw new Error("not a function call");
  return {
    methodName: call.methodName,
    args: JSON.parse(Buffer.from(call.args).toString("utf8")) as unknown,
    deposit: call.deposit,
    gas: call.gas,
  };
}

describe("usdcTransferAction", () => {
  it("builds ft_transfer with the amount as a string and 1 yoctoNEAR attached", () => {
    // #given
    const to = randomNearAccount();

    // #when
    const call = callIn(usdcTransferAction(to, 20_000_000n));

    // #then
    expect(call).toMatchObject({
      methodName: "ft_transfer",
      args: { receiver_id: to, amount: "20000000" },
      deposit: 1n,
    });
  });

  it("is a function call and nothing else", () => {
    // #when
    const action = usdcTransferAction("alice.near", 1n);

    // #then
    expect(
      Object.entries(action)
        .filter(([key, value]) => key !== "enum" && value !== undefined)
        .map(([key]) => key),
    ).toEqual(["functionCall"]);
  });

  it.each([
    ["an account ID with uppercase", "Alice.near"],
    ["an account ID with whitespace", " alice.near"],
    ["an empty account ID", ""],
    [
      "a Base address with its checksum case",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ],
  ])("refuses %s", (_name, to) => {
    // #when
    const build = () => usdcTransferAction(to, 1n);

    // #then
    expect(build).toThrow(RangeError);
  });

  it.each([
    ["zero", 0n],
    ["a negative amount", -1n],
    ["more than a u128 holds", 2n ** 128n],
  ])("refuses %s", (_name, amount) => {
    // #when
    const build = () => usdcTransferAction("alice.near", amount);

    // #then
    expect(build).toThrow(RangeError);
  });

  it("accepts the largest u128", () => {
    // #when
    const call = callIn(usdcTransferAction("alice.near", 2n ** 128n - 1n));

    // #then
    expect(call.args).toMatchObject({
      amount: "340282366920938463463374607431768211455",
    });
  });
});

describe("usdcTransferCallAction", () => {
  it("builds ft_transfer_call carrying the message, with 1 yoctoNEAR attached", () => {
    // #given
    const to = randomNearAccount();

    // #when
    const call = callIn(usdcTransferCallAction(to, 5_000_000n, "quote-1"));

    // #then
    expect(call).toMatchObject({
      methodName: "ft_transfer_call",
      args: { receiver_id: to, amount: "5000000", msg: "quote-1" },
      deposit: 1n,
    });
  });

  it("refuses a recipient that isn't a NEAR account ID", () => {
    // #when
    const build = () => usdcTransferCallAction("Not An Account", 1n, "");

    // #then
    expect(build).toThrow(RangeError);
  });
});

describe("usdcStorageDepositAction", () => {
  it("registers the account only, for exactly what USDC charges", () => {
    // #given
    const accountId = randomNearAccount();

    // #when
    const call = callIn(usdcStorageDepositAction(accountId));

    // #then
    expect(call).toMatchObject({
      methodName: "storage_deposit",
      args: { account_id: accountId, registration_only: true },
      deposit: USDC_STORAGE_DEPOSIT_YOCTO,
    });
  });
});
