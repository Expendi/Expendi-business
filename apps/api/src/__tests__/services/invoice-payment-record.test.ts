import type { Effect } from "effect";
import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { AppRuntime } from "../../runtime.js";
import type { AuditLog } from "../../services/audit/audit-log.js";
import type { RecordInvoicePaymentInput } from "../../services/invoices/payment-record.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import { invoicePayments, invoices } from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import {
  recordInvoicePayment,
  removeInvoicePayment,
} from "../../services/invoices/payment-record.js";
import {
  asAdmin,
  createCustomerAndInvoice,
  insertDeposit,
  insertInvoiceQuote,
  readInvoice,
} from "../helpers/invoices.js";
import { createFundedCompany } from "../helpers/money-in.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let funded: FundedCompany;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  funded = await createFundedCompany(db);
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const system = { type: "system" as const, id: "deposit-watcher" };

const paidOn = "2026-11-05";

/** Runs `work` in a scope like a route's (admin) or the watcher's (no role). */
function run<A, E>(
  scope: "admin" | "system",
  work: (tx: Transaction) => Effect.Effect<A, E, AuditLog>,
) {
  return runtime.runPromiseExit(
    withScope(
      scope === "admin"
        ? asAdmin(funded.company)
        : { organizationId: funded.company.organizationId },
      work,
    ),
  );
}

function record(
  scope: "admin" | "system",
  input: Partial<RecordInvoicePaymentInput> &
    Pick<RecordInvoicePaymentInput, "invoiceId" | "kind">,
) {
  return run(scope, (tx) =>
    recordInvoicePayment(tx, {
      organizationId: funded.company.organizationId,
      paidOn,
      actor:
        scope === "admin"
          ? { type: "user", id: funded.company.admin.id }
          : system,
      ...input,
    }),
  );
}

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? (Option.getOrNull(Cause.failureOption(exit.cause))?._tag ?? "defect")
    : "ok";

function succeeded<A>(exit: Exit.Exit<A, unknown>): A {
  if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
}

const openInvoice = () =>
  createCustomerAndInvoice(db, funded.company, { status: "open" });

async function voidInvoice(invoiceId: string) {
  await runInScope(db, asAdmin(funded.company), (tx) =>
    tx
      .update(invoices)
      .set({
        status: "void",
        voidedAt: new Date(),
        voidedReason: "Sent to the wrong customer",
        voidedBy: funded.company.admin.id,
      })
      .where(eq(invoices.id, invoiceId)),
  );
}

async function linkPayment(invoiceId: string) {
  const quote = await insertInvoiceQuote(db, funded, invoiceId);
  const walletTransactionId = await insertDeposit(db, funded);
  return {
    intentQuoteId: quote.id,
    walletTransactionId,
    amountUsdc: 100_000_000n,
  };
}

interface AuditRow {
  readonly action: string;
  readonly actorType: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

/** The audit log is insert-only for the app role, so the owner reads it. */
async function auditFor(invoiceId: string): Promise<AuditRow[]> {
  const { rows } = await owner.query<AuditRow>(
    `SELECT action, actor_type AS "actorType", before, after
       FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id`,
    [invoiceId],
  );
  return rows;
}

const paymentsOf = (invoiceId: string) =>
  runInScope(db, asAdmin(funded.company), (tx) =>
    tx
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId)),
  );

describe("recordInvoicePayment", () => {
  it("pays an open invoice marked paid outside Expendi", async () => {
    // #given
    const { invoiceId } = await openInvoice();

    // #when
    const result = succeeded(
      await record("admin", {
        invoiceId,
        kind: "outside",
        reference: "MPESA-QWE123",
        note: "Paid at the till",
      }),
    );

    // #then
    const invoice = await readInvoice(db, funded.company, invoiceId);
    expect(result.status).toBe("paid");
    expect(invoice.status).toBe("paid");
    expect(invoice.paidAt).toBeInstanceOf(Date);
    const [payment] = await paymentsOf(invoiceId);
    expect(payment).toMatchObject({
      id: result.paymentId,
      kind: "outside",
      reference: "MPESA-QWE123",
      amountUsdc: null,
      recordedBy: funded.company.admin.id,
    });
    expect(await auditFor(invoiceId)).toMatchObject([
      { action: "invoice.paid", actorType: "user" },
    ]);
  });

  it("pays an open invoice with a matched deposit", async () => {
    const { invoiceId } = await openInvoice();
    const walletTransactionId = await insertDeposit(db, funded);

    const result = succeeded(
      await record("admin", {
        invoiceId,
        kind: "matched",
        walletTransactionId,
        amountUsdc: 100_000_000n,
      }),
    );

    expect(result.status).toBe("paid");
    expect(await paymentsOf(invoiceId)).toMatchObject([
      { kind: "matched", walletTransactionId, amountUsdc: 100_000_000n },
    ]);
  });

  it("lets the deposit watcher's scope record a link payment", async () => {
    const { invoiceId } = await openInvoice();
    const link = await linkPayment(invoiceId);

    const result = succeeded(
      await record("system", { invoiceId, kind: "link", ...link }),
    );

    expect(result.status).toBe("paid");
    const [payment] = await paymentsOf(invoiceId);
    expect(payment).toMatchObject({ kind: "link", recordedBy: null });
    expect(await auditFor(invoiceId)).toMatchObject([
      { action: "invoice.paid", actorType: "system" },
    ]);
  });

  it("pays a voided invoice when the customer paid through the link", async () => {
    const { invoiceId } = await openInvoice();
    await voidInvoice(invoiceId);
    const link = await linkPayment(invoiceId);

    const result = succeeded(
      await record("system", { invoiceId, kind: "link", ...link }),
    );

    const invoice = await readInvoice(db, funded.company, invoiceId);
    expect(result.status).toBe("paid");
    expect(invoice).toMatchObject({
      status: "paid",
      voidedAt: null,
      voidedReason: null,
      voidedBy: null,
    });
    expect(await auditFor(invoiceId)).toMatchObject([
      {
        action: "invoice.paid",
        before: { status: "void", voidedReason: "Sent to the wrong customer" },
        after: { note: "paid after void" },
      },
    ]);
  });

  it("records a second link payment on a paid invoice and keeps it paid", async () => {
    const { invoiceId } = await openInvoice();
    succeeded(
      await record("system", {
        invoiceId,
        kind: "link",
        ...(await linkPayment(invoiceId)),
      }),
    );
    const paidAt = (await readInvoice(db, funded.company, invoiceId)).paidAt;

    const second = succeeded(
      await record("system", {
        invoiceId,
        kind: "link",
        ...(await linkPayment(invoiceId)),
      }),
    );

    expect(second.status).toBe("paid");
    expect(await paymentsOf(invoiceId)).toHaveLength(2);
    expect((await readInvoice(db, funded.company, invoiceId)).paidAt).toEqual(
      paidAt,
    );
    expect((await auditFor(invoiceId)).map((entry) => entry.action)).toEqual([
      "invoice.paid",
      "invoice.payment_recorded",
    ]);
  });

  describe("refuses", () => {
    it("a draft", async () => {
      const { invoiceId } = await createCustomerAndInvoice(db, funded.company);

      const exit = await record("admin", { invoiceId, kind: "outside" });

      expect(failureTag(exit)).toBe("Conflict");
      expect(await paymentsOf(invoiceId)).toEqual([]);
    });

    it("a payment recorded by hand on a voided invoice", async () => {
      const { invoiceId } = await openInvoice();
      await voidInvoice(invoiceId);

      const exit = await record("admin", { invoiceId, kind: "outside" });

      expect(failureTag(exit)).toBe("Conflict");
      expect((await readInvoice(db, funded.company, invoiceId)).status).toBe(
        "void",
      );
    });

    it("a payment recorded by hand on a paid invoice", async () => {
      const { invoiceId } = await openInvoice();
      succeeded(await record("admin", { invoiceId, kind: "outside" }));

      const exit = await record("admin", { invoiceId, kind: "outside" });

      expect(failureTag(exit)).toBe("Conflict");
      expect(await paymentsOf(invoiceId)).toHaveLength(1);
    });

    it("a deposit that already pays an invoice", async () => {
      const first = await openInvoice();
      const second = await openInvoice();
      const walletTransactionId = await insertDeposit(db, funded);
      succeeded(
        await record("admin", {
          invoiceId: first.invoiceId,
          kind: "matched",
          walletTransactionId,
          amountUsdc: 1n,
        }),
      );

      const exit = await record("admin", {
        invoiceId: second.invoiceId,
        kind: "matched",
        walletTransactionId,
        amountUsdc: 1n,
      });

      expect(failureTag(exit)).toBe("Conflict");
      expect(
        (await readInvoice(db, funded.company, second.invoiceId)).status,
      ).toBe("open");
    });

    it("an invoice that isn't there", async () => {
      const exit = await record("admin", {
        invoiceId: "00000000-0000-4000-8000-000000000000",
        kind: "outside",
      });

      expect(failureTag(exit)).toBe("NotFound");
    });

    it("another company's invoice", async () => {
      const other = await createFundedCompany(db);
      const { invoiceId } = await createCustomerAndInvoice(db, other.company, {
        status: "open",
      });

      const exit = await record("admin", { invoiceId, kind: "outside" });

      expect(failureTag(exit)).toBe("NotFound");
    });

    it("a payment whose kind and sources disagree, leaving the invoice open", async () => {
      const { invoiceId } = await openInvoice();

      const exit = await record("admin", {
        invoiceId,
        kind: "matched",
        amountUsdc: 1n,
      });

      expect(Exit.isFailure(exit)).toBe(true);
      expect((await readInvoice(db, funded.company, invoiceId)).status).toBe(
        "open",
      );
      expect(await auditFor(invoiceId)).toEqual([]);
    });
  });
});

describe("removeInvoicePayment", () => {
  const remove = (
    invoiceId: string,
    paymentId: string,
    organizationId = funded.company.organizationId,
  ) =>
    run("admin", (tx) =>
      removeInvoicePayment(tx, {
        organizationId,
        invoiceId,
        paymentId,
        actor: { type: "user", id: funded.company.admin.id },
      }),
    );

  it("reopens an invoice when its only payment is removed", async () => {
    const { invoiceId } = await openInvoice();
    const { paymentId } = succeeded(
      await record("admin", { invoiceId, kind: "outside" }),
    );

    const result = succeeded(await remove(invoiceId, paymentId));

    const invoice = await readInvoice(db, funded.company, invoiceId);
    expect(result.status).toBe("open");
    expect(invoice).toMatchObject({ status: "open", paidAt: null });
    expect(await paymentsOf(invoiceId)).toEqual([]);
    expect((await auditFor(invoiceId)).map((entry) => entry.action)).toEqual([
      "invoice.paid",
      "invoice.payment_removed",
    ]);
  });

  it("can be paid again after a matched payment is undone, with the same deposit", async () => {
    const { invoiceId } = await openInvoice();
    const walletTransactionId = await insertDeposit(db, funded);
    const input = {
      invoiceId,
      kind: "matched" as const,
      walletTransactionId,
      amountUsdc: 5n,
    };
    const { paymentId } = succeeded(await record("admin", input));
    succeeded(await remove(invoiceId, paymentId));

    const again = succeeded(await record("admin", input));

    expect(again.status).toBe("paid");
  });

  it("keeps the invoice paid while another payment remains", async () => {
    const { invoiceId } = await openInvoice();
    const link = await linkPayment(invoiceId);
    succeeded(await record("system", { invoiceId, kind: "link", ...link }));
    // A hand-recorded payment can't be added to a paid invoice, so this
    // one is written directly: the state it was in before the link payment.
    const walletTransactionId = await insertDeposit(db, funded);
    const [matched] = await runInScope(db, asAdmin(funded.company), (tx) =>
      tx
        .insert(invoicePayments)
        .values({
          organizationId: funded.company.organizationId,
          invoiceId,
          kind: "matched",
          walletTransactionId,
          amountUsdc: 5n,
          paidOn,
        })
        .returning({ id: invoicePayments.id }),
    );
    if (!matched) throw new Error("payment insert returned no row");
    const paymentId = matched.id;

    const result = succeeded(await remove(invoiceId, paymentId));

    expect(result.status).toBe("paid");
    expect((await readInvoice(db, funded.company, invoiceId)).status).toBe(
      "paid",
    );
  });

  it("refuses to undo a payment made through the pay link", async () => {
    const { invoiceId } = await openInvoice();
    const link = await linkPayment(invoiceId);
    const { paymentId } = succeeded(
      await record("system", { invoiceId, kind: "link", ...link }),
    );

    const exit = await remove(invoiceId, paymentId);

    expect(failureTag(exit)).toBe("Conflict");
    expect(await paymentsOf(invoiceId)).toHaveLength(1);
    expect((await readInvoice(db, funded.company, invoiceId)).status).toBe(
      "paid",
    );
  });

  it("finds no payment on another invoice", async () => {
    const first = await openInvoice();
    const second = await openInvoice();
    const { paymentId } = succeeded(
      await record("admin", { invoiceId: first.invoiceId, kind: "outside" }),
    );

    const exit = await remove(second.invoiceId, paymentId);

    expect(failureTag(exit)).toBe("NotFound");
    expect(await paymentsOf(first.invoiceId)).toHaveLength(1);
  });
});
