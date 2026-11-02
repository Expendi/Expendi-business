import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";

import type { ClaimApproval, ClaimDetail } from "@expendi-business/shared";
import {
  claimApprovalSchema,
  claimDetailSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { TestUser } from "./db.js";
import type { makeFakeFileStorage, makeFakePaycrest } from "./fakes.js";
import type { PayingCompany } from "./payouts.js";
import { users } from "../../db/schema/index.js";
import {
  addCategory,
  claimRequest,
  sendJson,
  uploadReceipt,
} from "./claims.js";
import { addMember, createUser } from "./db.js";
import { signPaycrestBody, TEST_ORIGIN } from "./fakes.js";
import { readPayout } from "./payouts.js";

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];

export interface ClaimFlowDeps {
  readonly app: App;
  readonly db: Database;
  readonly storage: ReturnType<typeof makeFakeFileStorage>;
  readonly paycrest: ReturnType<typeof makeFakePaycrest>;
}

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

/** As T32 leaves someone who confirmed their M-Pesa number, named so Paycrest can pay them. */
export async function makePayable(
  db: Database,
  user: TestUser,
  fullName: string,
): Promise<void> {
  await db
    .update(users)
    .set({
      phone: `+2547${randomInt(10_000_000, 100_000_000)}`,
      phoneVerifiedAt: new Date(),
      fullName,
    })
    .where(eq(users.id, user.id));
}

/**
 * A claim's life through the routes, as an employee and an admin of
 * `paying` drive it: submit, reject, resubmit, Approve & pay, and Paycrest
 * settling or refusing the order.
 */
export function claimFlow(deps: ClaimFlowDeps, paying: PayingCompany) {
  const { app, db, storage, paycrest } = deps;
  const company = paying.company;
  const claimsPath = `/organizations/${company.organizationId}/claims`;
  let categoryId: string | null = null;

  async function category(): Promise<string> {
    categoryId ??= await addCategory(db, company, "Meals");
    return categoryId;
  }

  async function approveAndPay(claimId: string): Promise<Payout> {
    const prepared = await sendJson(
      app,
      `${claimsPath}/approval`,
      company.admin,
      { method: "POST", body: { claimIds: [claimId] } },
    );
    if (prepared.status !== 201) {
      throw new Error(`approval answered ${prepared.status}`);
    }
    const data = await dataOf(prepared);
    const approval: ClaimApproval = claimApprovalSchema.parse(data);
    const options = (data as { options: SignOptions }).options;
    const confirmed = await sendJson(
      app,
      `${claimsPath}/approval/${approval.challengeId}/confirm`,
      company.admin,
      {
        method: "POST",
        body: { response: paying.passkey.sign(options, TEST_ORIGIN) },
      },
    );
    if (confirmed.status !== 200) {
      throw new Error(`confirm answered ${confirmed.status}`);
    }
    return readPayout(db, company, approval.claims[0]?.payoutId ?? "");
  }

  return {
    claimsPath,

    /** A new active member of the company, ready to be paid. */
    async employee(fullName = "Jane Wanjiku"): Promise<{
      readonly user: TestUser;
      readonly membershipId: string;
    }> {
      const user = await createUser(db);
      const membershipId = await addMember(db, company, user);
      await makePayable(db, user, fullName);
      return { user, membershipId };
    },

    async submit(user: TestUser, amountKes = "1,500.50"): Promise<ClaimDetail> {
      const upload = await uploadReceipt(app, storage, company, user);
      const response = await sendJson(app, claimsPath, user, {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [upload.receiptFileId],
          categoryId: await category(),
          amountKes,
        }),
      });
      if (response.status !== 201) {
        throw new Error(`submit answered ${response.status}`);
      }
      return claimDetailSchema.parse(await dataOf(response));
    },

    async reject(claimId: string, reason: string): Promise<void> {
      const response = await sendJson(
        app,
        `${claimsPath}/${claimId}/reject`,
        company.admin,
        { method: "POST", body: { reason } },
      );
      if (response.status !== 200) {
        throw new Error(`reject answered ${response.status}`);
      }
    },

    async edit(
      user: TestUser,
      claimId: string,
      changes: Record<string, unknown>,
    ): Promise<void> {
      const response = await sendJson(app, `${claimsPath}/${claimId}`, user, {
        method: "PATCH",
        body: changes,
      });
      if (response.status !== 200) {
        throw new Error(`edit answered ${response.status}`);
      }
    },

    approveAndPay,

    /** Paycrest settles the order and says so by signed webhook. */
    async pay(claimId: string): Promise<void> {
      const payout = await approveAndPay(claimId);
      const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
      if (!order) throw new Error("no order for payout");
      paycrest.state.orders.set(order.id, {
        ...order,
        status: "settled",
        paymentReference: "SKL3ABCDEF",
      });
      const body = JSON.stringify({
        event: "payment_order.settled",
        webhookVersion: "1",
        data: { id: payout.providerOrderId, status: "settled" },
      });
      const response = await app.request("/webhooks/paycrest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-paycrest-signature": signPaycrestBody(body),
        },
        body,
      });
      if (response.status !== 200) {
        throw new Error(`webhook answered ${response.status}`);
      }
    },

    /** Paycrest refuses the order, so the payout fails at once. */
    async failPayout(claimId: string): Promise<void> {
      paycrest.state.nextCreateFailure = "refused";
      const payout = await approveAndPay(claimId);
      if (payout.status !== "failed") {
        throw new Error(`payout is ${payout.status}, not failed`);
      }
    },
  };
}

export type ClaimFlow = ReturnType<typeof claimFlow>;
