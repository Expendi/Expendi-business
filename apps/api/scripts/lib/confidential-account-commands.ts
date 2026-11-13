import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { ConfigService } from "../../src/config.js";
import type { DatabaseService } from "../../src/db/client.js";
import type { WalletBalanceHome } from "../../src/db/schema/wallets.js";
import type { Transaction } from "../../src/db/scope.js";
import type { DatabaseError } from "../../src/errors.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
  RESERVING_STATUSES,
  treasuryMoves,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../src/db/schema/index.js";
import { query, withScope } from "../../src/db/scope.js";
import { AuditLog } from "../../src/services/audit/audit-log.js";
import { ConfidentialAccounts } from "../../src/services/intents/confidential-account.js";
import { banner, formatUsdc, QaUsageError } from "./treasury-qa-commands.js";

/**
 * What `scripts/confidential-account.ts` does, one Effect program per
 * command, so a test can drive them. Turning a company's balance home on or
 * off only flips `wallets.balance_home` and audits it: the move-in job does
 * the moving, over the company's whole balance, on its next run.
 */

const ACTOR = { type: "system", id: "confidential-account-script" } as const;

export const DEMO_ORGANIZATION_ENV =
  "CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID";

export interface ConfidentialAccountOptions {
  readonly organizationId: string;
  /** `--company-name`: must be the company's name exactly. */
  readonly companyName: string | undefined;
  /** `--yes`. */
  readonly confirmed: boolean;
  /**
   * The value of `CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID`, which is set
   * only in the staging configuration: it names the one company the script
   * may switch, and the config has no environment name to test instead.
   */
  readonly demoOrganizationId: string | undefined;
}

export interface BalanceHomeChange {
  readonly companyName: string;
  readonly balanceHome: WalletBalanceHome;
  /** What the confidential account held when the sign-in was proved. */
  readonly confidentialUsdc: bigint;
}

const usage = (message: string) => Effect.fail(new QaUsageError({ message }));

/** What of the company's is still moving, and so stops the switch. */
function inFlight(
  tx: Transaction,
  organizationId: string,
  walletId: string,
): Effect.Effect<readonly string[], DatabaseError> {
  return Effect.gen(function* () {
    const quotes = yield* query(() =>
      tx
        .select({ purpose: intentQuotes.purpose, status: intentQuotes.status })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            inArray(intentQuotes.status, [...UNSETTLED_INTENT_QUOTE_STATUSES]),
          ),
        ),
    );
    const reservingPayouts = yield* query(() =>
      tx
        .select({ status: payouts.status })
        .from(payouts)
        .where(
          and(
            eq(payouts.walletId, walletId),
            inArray(payouts.status, [...RESERVING_STATUSES, "needs_review"]),
          ),
        ),
    );
    const moves = yield* query(() =>
      tx
        .select({ status: treasuryMoves.status })
        .from(treasuryMoves)
        .where(
          and(
            eq(treasuryMoves.walletId, walletId),
            inArray(treasuryMoves.status, ["open", "needs_review"]),
          ),
        ),
    );
    const sends = yield* query(() =>
      tx
        .select({ status: companyWalletSends.status })
        .from(companyWalletSends)
        .where(
          and(
            eq(companyWalletSends.walletId, walletId),
            inArray(companyWalletSends.status, ["reserved", "signed"]),
          ),
        ),
    );
    return [
      ...quotes.map(({ purpose, status }) => `a ${purpose} quote is ${status}`),
      ...reservingPayouts.map(({ status }) => `a payout is ${status}`),
      ...moves.map(({ status }) => `a Treasury move is ${status}`),
      ...sends.map(({ status }) => `a company wallet send is ${status}`),
    ];
  });
}

/**
 * Sets the company's balance home after every guard has held, in this order:
 * the environment names this company, the company name was typed exactly,
 * `--yes`, nothing of the company's in flight, and the company's
 * confidential account answers (which proves its sign-in and the partner
 * key). The change and its audit entry are one transaction under the company
 * wallet's row lock, which checks again that nothing is in flight.
 */
export const setBalanceHome = (
  options: ConfidentialAccountOptions,
  target: WalletBalanceHome,
): Effect.Effect<
  BalanceHomeChange,
  QaUsageError | DatabaseError,
  DatabaseService | ConfigService | ConfidentialAccounts | AuditLog
> =>
  Effect.gen(function* () {
    const { organizationId } = options;
    const { companyName } = yield* banner(organizationId);
    if (options.demoOrganizationId !== organizationId) {
      return yield* usage(
        `${DEMO_ORGANIZATION_ENV} must equal --organization-id. It is set only in the staging configuration`,
      );
    }
    if (options.companyName !== companyName) {
      return yield* usage(
        `Pass --company-name exactly as the company is named: "${companyName}"`,
      );
    }
    if (!options.confirmed) {
      return yield* usage(
        "This changes where the company's USDC is kept. Run it again with --yes to go ahead",
      );
    }

    const found = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [wallet] = yield* query(() =>
          tx
            .select()
            .from(wallets)
            .where(eq(wallets.organizationId, organizationId)),
        );
        if (
          wallet?.status !== "active" ||
          wallet.chain !== "near" ||
          wallet.address === null ||
          wallet.privyWalletId === null
        ) {
          return null;
        }
        return {
          id: wallet.id,
          address: wallet.address,
          privyWalletId: wallet.privyWalletId,
          balanceHome: wallet.balanceHome,
          busy: yield* inFlight(tx, organizationId, wallet.id),
        };
      }),
    );
    if (found === null) {
      return yield* usage("The company has no active company wallet on NEAR");
    }
    if (found.balanceHome === target) {
      return yield* usage(`The company's balance home is already ${target}`);
    }
    if (found.busy.length > 0) {
      return yield* usage(
        `Something of the company's is in flight: ${found.busy.join("; ")}`,
      );
    }

    const accounts = yield* ConfidentialAccounts;
    const readConfidentialUsdc = accounts
      .usdcBalance({
        privyWalletId: found.privyWalletId,
        accountId: found.address,
      })
      .pipe(
        Effect.catchAll((error) =>
          usage(
            `The company's confidential account couldn't be read, so sign-in or the partner key is not working: ${error.message}`,
          ),
        ),
      );
    const refuseWhileFunded = (balance: bigint) =>
      target === "company_wallet" && balance !== 0n
        ? usage(
            `The company's confidential account still holds ${formatUsdc(balance)} USDC. Moving a balance back out of a confidential account isn't built yet, so a company that is turned on stays on until it is`,
          )
        : Effect.void;
    const confidentialUsdc = yield* readConfidentialUsdc;
    yield* refuseWhileFunded(confidentialUsdc);

    yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* query(() =>
          tx
            .select({ id: wallets.id })
            .from(wallets)
            .where(eq(wallets.id, found.id))
            .for("update"),
        );
        const busy = yield* inFlight(tx, organizationId, found.id);
        if (busy.length > 0) {
          return yield* usage(
            `Something of the company's is in flight: ${busy.join("; ")}`,
          );
        }
        yield* refuseWhileFunded(yield* readConfidentialUsdc);
        yield* query(() =>
          tx
            .update(wallets)
            .set({ balanceHome: target })
            .where(eq(wallets.id, found.id)),
        );
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: "wallet.balance_home_changed",
          entity: { type: "wallet", id: found.id },
          before: { balanceHome: found.balanceHome },
          after: { balanceHome: target, confidentialUsdc },
        });
      }),
    );
    return { companyName, balanceHome: target, confidentialUsdc };
  });

export const turnOn = (options: ConfidentialAccountOptions) =>
  setBalanceHome(options, "confidential_account");

export const turnOff = (options: ConfidentialAccountOptions) =>
  setBalanceHome(options, "company_wallet");
