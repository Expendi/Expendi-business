/**
 * Fake card activity in Lithic's sandbox (spec §6.25). Lithic then calls the
 * deployed API exactly as it would for a real purchase. The full card number
 * these calls need is fetched on each run and never stored or printed.
 *
 *   authorize --last-four 1234 --amount 54.00 [--merchant "ACME"] [--mcc 5734]
 *   clear     --tx <token> [--amount 60.00]    settle all of it, or that much
 *   void      --tx <token> [--amount 3.00]     release a hold (Lithic's expiry)
 *   refund    --last-four 1234 --amount 54.00 [--merchant "ACME"]
 *   show      --tx <token>
 *
 * A void uses Lithic's expiry type because the sandbox accepts a reversal and
 * then does nothing with it.
 *
 * Run: doppler run -p expendi-business -c dev -- pnpm --filter
 *      @expendi-business/api exec tsx scripts/lithic-simulate.ts <command> …
 */
import { parseArgs } from "node:util";
import { z } from "zod";

import { parseKesToCents } from "@expendi-business/shared";

import { pauseAfterWrite, sandboxCall } from "./lib/lithic-sandbox.js";

const cardSchema = z.looseObject({
  token: z.string(),
  last_four: z.string(),
  state: z.string(),
  pan: z.string().optional(),
});

const transactionSchema = z.looseObject({
  status: z.string(),
  result: z.string(),
  amounts: z.object({
    hold: z.object({ amount: z.number() }),
    settlement: z.object({ amount: z.number() }),
  }),
  events: z.array(z.looseObject({ type: z.string() })),
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "last-four": { type: "string" },
    tx: { type: "string" },
    amount: { type: "string" },
    merchant: { type: "string" },
    mcc: { type: "string" },
  },
});

function centsFrom(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const cents = parseKesToCents(raw);
  if (cents === null) throw new Error(`Not a USD amount: ${raw}`);
  return Number(cents);
}

function need(name: "last-four" | "tx" | "amount"): string {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function panFor(lastFour: string): Promise<string> {
  const { data } = z
    .looseObject({ data: z.array(cardSchema) })
    .parse(await sandboxCall("GET", "/v1/cards?page_size=100"));
  const card = data.find(
    (row) => row.last_four === lastFour && row.state !== "CLOSED",
  );
  if (!card) throw new Error(`No open sandbox card ending ${lastFour}`);
  const detail = cardSchema.parse(
    await sandboxCall("GET", `/v1/cards/${card.token}`),
  );
  if (!detail.pan) throw new Error("The sandbox didn't return the card number");
  return detail.pan;
}

async function readTransaction(token: string) {
  return transactionSchema.parse(
    await sandboxCall("GET", `/v1/transactions/${token}`),
  );
}

async function show(token: string): Promise<void> {
  const { status, result, amounts, events } = await readTransaction(token);
  console.log(
    JSON.stringify(
      {
        token,
        status,
        result,
        holdCents: amounts.hold.amount,
        settledCents: amounts.settlement.amount,
        events: events.map(({ type }) => type),
      },
      null,
      2,
    ),
  );
}

const merchant = (values.merchant ?? "SANDBOX MERCHANT").slice(0, 25);
const [command] = positionals;

if (command === "authorize") {
  const { token } = await sandboxCall("POST", "/v1/simulate/authorize", {
    descriptor: merchant,
    amount: centsFrom(need("amount")),
    mcc: values.mcc ?? "5734",
    pan: await panFor(need("last-four")),
  });
  await pauseAfterWrite();
  await show(String(token));
} else if (command === "clear") {
  const tx = need("tx");
  await sandboxCall("POST", "/v1/simulate/clearing", {
    token: tx,
    ...(values.amount && { amount: centsFrom(values.amount) }),
  });
  await pauseAfterWrite();
  await show(tx);
} else if (command === "void") {
  const tx = need("tx");
  const held = Math.abs((await readTransaction(tx)).amounts.hold.amount);
  await sandboxCall("POST", "/v1/simulate/void", {
    token: tx,
    type: "AUTHORIZATION_EXPIRY",
    amount: centsFrom(values.amount) ?? held,
  });
  await pauseAfterWrite();
  await show(tx);
} else if (command === "refund") {
  const { token } = await sandboxCall("POST", "/v1/simulate/return", {
    descriptor: merchant,
    amount: centsFrom(need("amount")),
    pan: await panFor(need("last-four")),
  });
  await pauseAfterWrite();
  await show(String(token));
} else if (command === "show") {
  await show(need("tx"));
} else {
  throw new Error("Use: authorize | clear | void | refund | show");
}
