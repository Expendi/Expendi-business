import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";

import type { Database } from "../../db/client.js";
import type {
  NewBill,
  NewExpense,
  NewPayout,
  NewReceiptFile,
} from "../../db/schema/index.js";
import type { TestCompany, TestUser } from "./db.js";
import type { makeFakeFileStorage } from "./fakes.js";
import {
  expenses,
  floatMovements,
  floats,
  payouts,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { insertBill } from "./bills.js";

type FakeFileStorage = ReturnType<typeof makeFakeFileStorage>;

export const asAdmin = (company: TestCompany) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

export async function nameUser(
  db: Database,
  user: TestUser,
  fullName: string,
): Promise<void> {
  await db.update(users).set({ fullName }).where(eq(users.id, user.id));
}

/** Writes rows straight to the tables, in the shapes the API leaves them. */
export function exportSeeder(
  db: Database,
  company: TestCompany,
  walletId: string,
  storage: FakeFileStorage,
) {
  const scope = asAdmin(company);

  async function expense(
    values: Partial<NewExpense> & Pick<NewExpense, "categoryId">,
  ) {
    const [row] = await runInScope(db, scope, (tx) =>
      tx
        .insert(expenses)
        .values({
          organizationId: company.organizationId,
          membershipId: company.adminMembershipId,
          kind: "company",
          overviewHeading: "transactions",
          merchant: "Java House",
          amountKes: 150_000n,
          spentOn: "2026-10-15",
          status: "recorded",
          ...values,
        })
        .returning(),
    );
    if (!row) throw new Error("expense insert returned no row");
    return row;
  }

  async function payout(subjectId: string, values: Partial<NewPayout> = {}) {
    const paidAt = values.paidAt ?? new Date("2026-10-10T09:00:00Z");
    const [row] = await runInScope(db, scope, (tx) =>
      tx
        .insert(payouts)
        .values({
          organizationId: company.organizationId,
          walletId,
          subjectType: "bill",
          subjectId,
          idempotencyKey: randomUUID(),
          method: "mpesa_till",
          recipient: {
            method: "mpesa_till",
            tillNumber: "123456",
            accountName: "Supplier",
          },
          requestedKesCents: 10_000n,
          amountKes: 10_000n,
          quotedRate: "129",
          quotedUsdc: 1_000_000n,
          maxDebitUsdc: 1_000_000n,
          status: "paid",
          approvedBy: company.admin.id,
          approvedAt: paidAt,
          approvalId: randomUUID(),
          amountToTransferUsdc: 1_000_000n,
          depositAddress: `0x${"a".repeat(40)}`,
          fundingStartedAt: paidAt,
          providerOrderId: `order-${randomUUID().slice(0, 8)}`,
          paidAt,
          ...values,
        })
        .returning(),
    );
    if (!row) throw new Error("payout insert returned no row");
    return row;
  }

  /** A bill paid through Expendi by one payout per part. */
  async function paidBill(
    values: Partial<NewBill> & Pick<NewBill, "payeeId" | "categoryId">,
    parts: readonly Partial<NewPayout>[] = [{}],
  ) {
    const billId = randomUUID();
    const paid = [];
    for (const [index, part] of parts.entries()) {
      paid.push(
        await payout(billId, {
          subjectPart: index + 1,
          payrollRunId: values.payrollRunId ?? null,
          ...part,
        }),
      );
    }
    const latest = paid.at(-1);
    await insertBill(db, company, {
      id: billId,
      status: "paid",
      dueOn: values.paidOn ?? "2026-10-10",
      paidOn: "2026-10-10",
      paidAt: new Date("2026-10-10T09:00:00Z"),
      payoutId: latest?.id ?? null,
      ...values,
    });
    return { billId, payouts: paid };
  }

  async function paidOutsideBill(
    values: Partial<NewBill> & Pick<NewBill, "payeeId" | "categoryId">,
    spending: Partial<NewExpense> = {},
  ) {
    const billId = await insertBill(db, company, {
      status: "paid_outside",
      dueOn: values.paidOn ?? "2026-10-05",
      paidOn: "2026-10-05",
      paidAt: new Date("2026-10-05T09:00:00Z"),
      markedPaidBy: company.admin.id,
      ...values,
    });
    const recorded = await expense({
      categoryId: values.categoryId,
      billId,
      merchant: "Landlord",
      amountKes: values.amountKes ?? 250_000n,
      spentOn: values.paidOn ?? "2026-10-05",
      ...spending,
    });
    return { billId, spendingId: recorded.id };
  }

  async function openFloat(membershipId: string) {
    const [row] = await runInScope(db, scope, (tx) =>
      tx
        .insert(floats)
        .values({ organizationId: company.organizationId, membershipId })
        .returning(),
    );
    if (!row) throw new Error("float insert returned no row");
    return row;
  }

  /** A float issue or top-up, paid to the holder through Expendi. */
  async function floatPayment(
    floatId: string,
    type: "issue" | "top_up",
    amountKes: bigint,
    paidAt: Date,
  ) {
    const movementId = randomUUID();
    const funding = await payout(movementId, {
      subjectType: "float",
      requestedKesCents: amountKes,
      amountKes,
      paidAt,
    });
    await runInScope(db, scope, (tx) =>
      tx.insert(floatMovements).values({
        id: movementId,
        organizationId: company.organizationId,
        floatId,
        type,
        status: "paid",
        amountKes,
        payoutId: funding.id,
        recordedBy: company.admin.id,
        paidAt,
      }),
    );
    return { movementId, payout: funding };
  }

  /** A receipt file in the fake R2, or a pasted SMS. */
  async function receipt(
    owner: { readonly expenseId: string } | { readonly billId: string },
    file:
      | { readonly contentType: string; readonly bytes: Uint8Array }
      | { readonly sms: string } = {
      contentType: "image/jpeg",
      bytes: randomBytes(16),
    },
    { uploaded = true }: { readonly uploaded?: boolean } = {},
  ) {
    const id = randomUUID();
    const values: NewReceiptFile =
      "sms" in file
        ? {
            id,
            organizationId: company.organizationId,
            uploadedBy: company.admin.id,
            kind: "sms_text",
            smsText: file.sms,
            sha256: randomBytes(32).toString("hex"),
            contentType: "text/plain",
            byteSize: file.sms.length,
          }
        : {
            id,
            organizationId: company.organizationId,
            uploadedBy: company.admin.id,
            kind: file.contentType === "application/pdf" ? "pdf" : "photo",
            storageKey: `org/${company.organizationId}/receipts/${id}`,
            sha256: randomBytes(32).toString("hex"),
            contentType: file.contentType,
            byteSize: file.bytes.byteLength,
          };
    if (!("sms" in file) && values.storageKey && uploaded) {
      storage.state.put(
        values.storageKey,
        file.bytes.byteLength,
        file.contentType,
        file.bytes,
      );
    }
    await runInScope(db, scope, (tx) =>
      tx.insert(receiptFiles).values({
        ...values,
        ...owner,
        ...("billId" in owner ? { billRole: "invoice" as const } : {}),
      }),
    );
    return id;
  }

  return {
    expense,
    payout,
    paidBill,
    paidOutsideBill,
    openFloat,
    floatPayment,
    receipt,
  };
}

/** A zip's files by name. */
export const unzip = (bytes: Uint8Array): Record<string, Uint8Array> =>
  unzipSync(bytes);

/** Reads back a CSV the export wrote: drops the byte-order mark, then splits quoted cells. */
export function parseCsv(bytes: Uint8Array): string[][] {
  const text = strFromU8(bytes).replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else {
      cell += char;
    }
  }
  return rows;
}
