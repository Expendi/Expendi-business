/**
 * Checkpoint B live payouts, through the real engine: no claims or screens
 * exist yet (Phase 2), so this script stands in for the app. The admin's
 * passkey is a software passkey stored in a git-ignored, owner-only file.
 *
 *   enrol   --organization-id <id> --admin-email <email>
 *   pay     --organization-id <id> --admin-email <email> --batch <file.json>
 *   status  --organization-id <id> --payout-id <id>
 *   retry   --organization-id <id> --admin-email <email> --payout-id <id>
 *           [--recipient '<KesRecipient JSON>']   (a failed payout, paid again)
 *   reconcile                                     (one reconciliation pass)
 *   allow   --organization-id <id> --admin-email <email> --address <0x…>
 *           --label <name>                        (add to the allowlist)
 *
 * A batch file is an array of payments, all paid under one approval:
 *   [{ "kes": "99.50", "recipient": { "method": "mpesa_phone",
 *      "phone": "+254712345678", "accountName": "Jane Wanjiku" } },
 *    { "usdc": "1.5", "recipient": { "method": "usdc",
 *      "address": "0x…", "accountName": "Treasury" } }]
 * A USDC address must be on the allowlist first (`allow`).
 * Recipients follow `KesRecipient` (services/paycrest/recipient.ts). Add
 * "payrollRunId" to every entry to pay a payroll run.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/test-payout.ts <command> …
 */
import "../src/secrets/bootstrap.js";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { AppDeps } from "../src/layers/main.js";
import type { PayoutRecipient } from "../src/services/paycrest/recipient.js";
import type { PayoutRequest } from "../src/services/payout/payout-service.js";
import { DatabaseService } from "../src/db/client.js";
import { payouts, users } from "../src/db/schema/index.js";
import { query, withScope } from "../src/db/scope.js";
import { makeRuntime } from "../src/runtime.js";
import {
  confirmAllowlistChange,
  requestAllowlistChange,
} from "../src/services/allowlist/allowlist.js";
import {
  ApprovalSettings,
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../src/services/approval/passkeys.js";
import { toMicro } from "../src/services/paycrest/amounts.js";
import { Paycrest } from "../src/services/paycrest/paycrest-client.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
  retryPayout,
} from "../src/services/payout/payout-service.js";
import { reconcilePaycrestPayouts } from "../src/services/payout/sync.js";
import { SoftwarePasskey } from "./lib/software-passkey.js";

const ACTOR = { type: "system", id: "test-payout-script" } as const;
const PASSKEY_DIR = new URL("../.cache/checkpoint-b/", import.meta.url);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "organization-id": { type: "string" },
    "admin-email": { type: "string" },
    batch: { type: "string" },
    "payout-id": { type: "string" },
    recipient: { type: "string" },
    address: { type: "string" },
    label: { type: "string" },
  },
});
const [command] = positionals;
const organizationId = values["organization-id"] ?? "";
if (command !== "reconcile" && !organizationId) {
  throw new Error("Pass --organization-id");
}

interface BatchEntry {
  readonly kes?: string;
  readonly usdc?: string;
  readonly recipient: PayoutRecipient;
  readonly payrollRunId?: string;
}

/** "99.50" → 9_950n; whole numbers allowed, at most 2 decimals. */
function kesToCents(kes: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(kes);
  if (!match?.[1]) throw new Error(`Not a KES amount: ${kes}`);
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

const passkeyFile = (userId: string) =>
  new URL(`passkey-${userId}.json`, PASSKEY_DIR);

async function savePasskey(userId: string, key: SoftwarePasskey) {
  await mkdir(PASSKEY_DIR, { recursive: true, mode: 0o700 });
  await writeFile(passkeyFile(userId), JSON.stringify(key.toJSON()), {
    mode: 0o600,
  });
}

async function loadPasskey(userId: string): Promise<SoftwarePasskey> {
  const raw = await readFile(passkeyFile(userId), "utf8");
  return SoftwarePasskey.restore(
    JSON.parse(raw) as ReturnType<SoftwarePasskey["toJSON"]>,
  );
}

const adminId = Effect.gen(function* () {
  const email = values["admin-email"]?.trim().toLowerCase();
  if (!email) return yield* Effect.dieMessage("Pass --admin-email");
  const { db } = yield* DatabaseService;
  const [user] = yield* query(() =>
    db.select({ id: users.id }).from(users).where(eq(users.email, email)),
  );
  return user?.id ?? (yield* Effect.dieMessage(`No user with email ${email}`));
});

const enrol = Effect.gen(function* () {
  const userId = yield* adminId;
  const settings = yield* ApprovalSettings;
  const origin = settings.origins[0] ?? "";
  const key = SoftwarePasskey.create();
  const options = yield* startPasskeyEnrolment(userId);
  yield* finishPasskeyEnrolment(userId, key.register(options, origin));
  yield* Effect.promise(() => savePasskey(userId, key));
  console.log(
    `Enrolled a software approval passkey for ${values["admin-email"] ?? userId}.`,
  );
});

const pay = Effect.gen(function* () {
  const userId = yield* adminId;
  const settings = yield* ApprovalSettings;
  const file = values.batch;
  if (!file) return yield* Effect.dieMessage("Pass --batch <file.json>");
  const entries = JSON.parse(
    yield* Effect.promise(() => readFile(file, "utf8")),
  ) as BatchEntry[];

  const requests: PayoutRequest[] = entries.map((entry) => {
    const subjectId = randomUUID();
    const base = {
      subjectType: "claim" as const,
      subjectId,
      idempotencyKey: `checkpoint-b:${subjectId}`,
      ...(entry.payrollRunId && { payrollRunId: entry.payrollRunId }),
    };
    if (entry.recipient.method === "usdc") {
      if (!entry.usdc) throw new Error('A USDC entry needs "usdc"');
      return {
        ...base,
        recipient: entry.recipient,
        amountUsdc: toMicro(entry.usdc),
      };
    }
    if (!entry.kes) throw new Error('A KES entry needs "kes"');
    return {
      ...base,
      recipient: entry.recipient,
      amountKesCents: kesToCents(entry.kes),
    };
  });
  const prepared = yield* preparePayouts({
    organizationId,
    actor: ACTOR,
    requests,
  });
  const approval = yield* requestPayoutApproval({
    organizationId,
    userId,
    payoutIds: prepared.map((payout) => payout.id),
  });
  console.log(
    `Approving ${prepared.length} payout(s): KES ${approval.totalKes / 100n} to recipients, at most ${approval.totalMaxDebitUsdc} USDC base units from the wallet.`,
  );

  const key = yield* Effect.promise(() => loadPasskey(userId));
  const response = key.sign(approval.options, settings.origins[0] ?? "");
  yield* Effect.promise(() => savePasskey(userId, key));

  const results = yield* approveAndPay({
    organizationId,
    userId,
    challengeId: approval.challengeId,
    response,
  });
  for (const { payoutId, payout } of results) {
    console.log(
      JSON.stringify(
        {
          payoutId,
          status: payout?.status ?? "funding broke: check the logs",
          amountKes: payout?.amountKes.toString(),
          providerOrderId: payout?.providerOrderId,
          amountToTransferUsdc: payout?.amountToTransferUsdc?.toString(),
          txHash: payout?.txHash,
          failureReason: payout?.failureReason,
        },
        null,
        2,
      ),
    );
  }
});

const status = Effect.gen(function* () {
  const payoutId = values["payout-id"];
  if (!payoutId) return yield* Effect.dieMessage("Pass --payout-id");
  const [payout] = yield* withScope({ organizationId }, (tx) =>
    query(() => tx.select().from(payouts).where(eq(payouts.id, payoutId))),
  );
  if (!payout) return yield* Effect.dieMessage(`No payout ${payoutId}`);
  const paycrest = yield* Paycrest;
  const order = payout.providerOrderId
    ? yield* paycrest.getOrder(payout.providerOrderId)
    : null;
  console.log(
    JSON.stringify(
      {
        payout: {
          id: payout.id,
          status: payout.status,
          amountKes: payout.amountKes.toString(),
          txHash: payout.txHash,
          failureReason: payout.failureReason,
        },
        paycrest: order && {
          id: order.id,
          status: order.status,
          txHash: order.txHash,
          paymentReference: order.paymentReference,
        },
      },
      null,
      2,
    ),
  );
});

const retry = Effect.gen(function* () {
  const userId = yield* adminId;
  const settings = yield* ApprovalSettings;
  const failedPayoutId = values["payout-id"];
  if (!failedPayoutId) return yield* Effect.dieMessage("Pass --payout-id");
  const recipient = values.recipient
    ? (JSON.parse(values.recipient) as PayoutRecipient)
    : undefined;
  const fresh = yield* retryPayout({
    organizationId,
    failedPayoutId,
    idempotencyKey: `checkpoint-b:retry:${randomUUID()}`,
    actor: ACTOR,
    ...(recipient && { recipient }),
  });
  const approval = yield* requestPayoutApproval({
    organizationId,
    userId,
    payoutIds: [fresh.id],
  });
  const key = yield* Effect.promise(() => loadPasskey(userId));
  const response = key.sign(approval.options, settings.origins[0] ?? "");
  yield* Effect.promise(() => savePasskey(userId, key));
  const [result] = yield* approveAndPay({
    organizationId,
    userId,
    challengeId: approval.challengeId,
    response,
  });
  console.log(
    JSON.stringify(
      {
        retryOf: failedPayoutId,
        payoutId: result?.payoutId,
        status: result?.payout?.status ?? "funding broke: check the logs",
        providerOrderId: result?.payout?.providerOrderId,
        txHash: result?.payout?.txHash,
        failureReason: result?.payout?.failureReason,
      },
      null,
      2,
    ),
  );
});

const reconcile = Effect.map(reconcilePaycrestPayouts(), (summary) =>
  console.log(JSON.stringify(summary)),
);

const allow = Effect.gen(function* () {
  const userId = yield* adminId;
  const settings = yield* ApprovalSettings;
  const address = values.address;
  const label = values.label;
  if (!address || !label) {
    return yield* Effect.dieMessage("Pass --address and --label");
  }
  const change = { action: "add", chain: "base", address, label } as const;
  const challenge = yield* requestAllowlistChange({
    organizationId,
    userId,
    change,
  });
  const key = yield* Effect.promise(() => loadPasskey(userId));
  const response = key.sign(challenge.options, settings.origins[0] ?? "");
  yield* Effect.promise(() => savePasskey(userId, key));
  const row = yield* confirmAllowlistChange({
    organizationId,
    userId,
    challengeId: challenge.challengeId,
    response,
    change,
  });
  console.log(`Allowlisted ${row.address} (${row.label}).`);
});

const programs = { enrol, pay, status, retry, reconcile, allow } as const;
const program: Effect.Effect<unknown, unknown, AppDeps> =
  command && command in programs
    ? programs[command as keyof typeof programs]
    : Effect.dieMessage(
        `Unknown command "${command ?? ""}": use enrol, pay, status, retry, reconcile or allow`,
      );

const runtime = makeRuntime();
try {
  await runtime.runPromise(program);
} finally {
  await runtime.dispose();
}
