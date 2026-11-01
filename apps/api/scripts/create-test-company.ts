/**
 * Checkpoint B setup: creates a company with an admin, then its wallet
 * through the same `ensureCompanyWallet` that sign-up will use (T12). Safe to
 * re-run with --organization-id to finish a wallet whose creation stopped.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/create-test-company.ts \
 *        --name "Expendi Test Co" --admin-email you@example.com
 */
import "../src/secrets/bootstrap.js";

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Effect } from "effect";

import { DatabaseService } from "../src/db/client.js";
import { memberships, organizations, users } from "../src/db/schema/index.js";
import { query, withScope } from "../src/db/scope.js";
import { makeRuntime } from "../src/runtime.js";
import { AuditLog } from "../src/services/audit/audit-log.js";
import { normalizeEmail } from "../src/services/auth/authenticate.js";
import { ensureCompanyWallet } from "../src/services/wallet/company-wallet.js";

const ACTOR = { type: "system", id: "create-test-company" } as const;

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    "admin-email": { type: "string" },
    "organization-id": { type: "string" },
  },
});

/**
 * The admin row is created by email with no Privy ID, like an invite; their
 * first login claims it (T4).
 */
const createCompany = (name: string, adminEmail: string) =>
  Effect.gen(function* () {
    const { db } = yield* DatabaseService;
    yield* query(() =>
      db.insert(users).values({ email: adminEmail }).onConflictDoNothing(),
    );
    const admin = yield* query(() =>
      db.query.users.findFirst({
        where: (user, { eq }) => eq(user.email, adminEmail),
        columns: { id: true },
      }),
    );
    if (!admin) return yield* Effect.dieMessage("admin user missing");

    const organizationId = randomUUID();
    yield* withScope({ organizationId, userId: admin.id }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* query(() =>
          tx.insert(organizations).values({ id: organizationId, name }),
        );
        yield* query(() =>
          tx.insert(memberships).values({
            organizationId,
            userId: admin.id,
            role: "admin",
            status: "active",
          }),
        );
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: "organization.created",
          entity: { type: "organization", id: organizationId },
          after: { name, adminEmail },
        });
      }),
    );
    return organizationId;
  });

const program = Effect.gen(function* () {
  let organizationId = values["organization-id"];
  if (!organizationId) {
    const name = values.name;
    const adminEmail = normalizeEmail(values["admin-email"] ?? "");
    if (!name || !adminEmail) {
      return yield* Effect.dieMessage(
        "Pass --name and --admin-email, or --organization-id to resume",
      );
    }
    organizationId = yield* createCompany(name, adminEmail);
    console.log(`Created company ${organizationId}`);
  }

  const wallet = yield* ensureCompanyWallet({ organizationId, actor: ACTOR });
  console.log(`Wallet ${wallet.status}: ${wallet.address ?? "(none yet)"}
Per-transaction max: ${wallet.perTransactionMaxUsdc} USDC base units
Send a small amount of USDC on Base to that address; the deposit should
appear in GET /organizations/${organizationId}/wallet within a minute.`);
});

const runtime = makeRuntime();
try {
  await runtime.runPromise(program);
} finally {
  await runtime.dispose();
}
