import { randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import type {
  CreatePayeeRequest,
  PayeeDetails,
} from "@expendi-business/shared";
import { createPayeeRequestSchema } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayeeView } from "../../services/payees/payees.js";
import type { TestCompany } from "./db.js";
import type { PayingCompany } from "./payouts.js";
import { payees, users } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmPayeeChange,
  createPayee,
  requestPayeeDetailsChange,
} from "../../services/payees/payees.js";
import { TEST_ORIGIN } from "./fakes.js";

export const randomKenyanMobile = (): string =>
  `+2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;

/** Adds a payee, confirming its payment details with the admin's passkey. */
export async function addPayee(
  runtime: AppRuntime,
  { company, passkey }: PayingCompany,
  input: CreatePayeeRequest,
): Promise<PayeeView> {
  const admin = {
    organizationId: company.organizationId,
    userId: company.admin.id,
  };
  const result = await runtime.runPromise(
    createPayee(admin, createPayeeRequestSchema.parse(input)),
  );
  if (result.status === "created") return result.payee;
  return runtime.runPromise(
    confirmPayeeChange(admin, {
      challengeId: result.challengeId,
      response: passkey.sign(result.options, TEST_ORIGIN),
      change: result.change,
    }),
  );
}

/** Gives a payee new payment details, confirmed with the admin's passkey. */
export async function changePayeeDetails(
  runtime: AppRuntime,
  { company, passkey }: PayingCompany,
  payeeId: string,
  details: PayeeDetails,
): Promise<PayeeView> {
  const admin = {
    organizationId: company.organizationId,
    userId: company.admin.id,
  };
  const challenge = await runtime.runPromise(
    requestPayeeDetailsChange(admin, payeeId, details),
  );
  return runtime.runPromise(
    confirmPayeeChange(admin, {
      challengeId: challenge.challengeId,
      response: passkey.sign(challenge.options, TEST_ORIGIN),
      change: challenge.change,
    }),
  );
}

/** Moves the payee's last details change `hours` into the past. */
export async function ageDetailsChange(
  db: Database,
  company: TestCompany,
  payeeId: string,
  hours: number,
): Promise<void> {
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .update(payees)
      .set({
        detailsChangedAt: sql`now() - make_interval(secs => ${hours * 3600})`,
      })
      .where(eq(payees.id, payeeId)),
  );
}

/** Sets the person's confirmed M-Pesa number, as T32's SMS check would. */
export async function confirmPhone(
  db: Database,
  userId: string,
  phone: string | null,
): Promise<void> {
  await db
    .update(users)
    .set({ phone, phoneVerifiedAt: phone === null ? null : new Date() })
    .where(eq(users.id, userId));
}
