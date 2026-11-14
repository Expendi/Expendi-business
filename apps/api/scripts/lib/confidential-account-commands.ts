import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { ConfigService } from "../../src/config.js";
import { intentQuotes, wallets } from "../../src/db/schema/index.js";
import { query, withScope } from "../../src/db/scope.js";
import { changeBalanceHome } from "../../src/services/intents/balance-home.js";
import { banner, QaUsageError } from "./treasury-qa-commands.js";

export const DEMO_ORGANIZATION_ENV =
  "CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID";

export interface ConfidentialAccountOptions {
  readonly organizationId: string;
  readonly companyName: string | undefined;
  readonly confirmed: boolean;
  /** Retained for the staging pilot before the environment-wide rollout. */
  readonly demoOrganizationId: string | undefined;
}

export const setBalanceHome = (
  options: ConfidentialAccountOptions,
  target: "company_wallet" | "confidential_account",
) =>
  Effect.gen(function* () {
    const { companyName } = yield* banner(options.organizationId);
    const config = yield* ConfigService;
    // Rollback remains available with the rollout switch off. Turning on
    // outside the pilot requires the environment's rollout switch.
    if (
      target === "confidential_account" &&
      !config.confidentialAccountsEnabled &&
      options.demoOrganizationId !== options.organizationId
    ) {
      return yield* Effect.fail(
        new QaUsageError({
          message: `${DEMO_ORGANIZATION_ENV} must equal --organization-id, or CONFIDENTIAL_ACCOUNTS_ENABLED must be true`,
        }),
      );
    }
    if (options.companyName !== companyName) {
      return yield* Effect.fail(
        new QaUsageError({
          message: `Pass --company-name exactly as the company is named: "${companyName}"`,
        }),
      );
    }
    if (!options.confirmed) {
      return yield* Effect.fail(
        new QaUsageError({
          message:
            "This changes where the company's USDC is kept. Run it again with --yes to go ahead",
        }),
      );
    }
    const result = yield* changeBalanceHome(
      options.organizationId,
      target,
    ).pipe(
      Effect.catchTag("BalanceHomeNotReady", (error) =>
        Effect.fail(new QaUsageError({ message: error.message })),
      ),
    );
    return { companyName, ...result };
  });

export const turnOn = (options: ConfidentialAccountOptions) =>
  setBalanceHome(options, "confidential_account");
export const turnOff = (options: ConfidentialAccountOptions) =>
  setBalanceHome(options, "company_wallet");

/** Saved state only: no sign-in or money movement for a status read. */
export const balanceHomeStatus = (organizationId: string) =>
  withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [wallet] = yield* query(() =>
        tx
          .select({
            id: wallets.id,
            balanceHome: wallets.balanceHome,
            draining: wallets.balanceHomeChanging,
            optedOut: wallets.confidentialOptOut,
            confidentialUsdc: wallets.confidentialUsdc,
            readAt: wallets.confidentialUsdcReadAt,
          })
          .from(wallets)
          .where(eq(wallets.organizationId, organizationId)),
      );
      if (!wallet)
        return yield* Effect.fail(
          new QaUsageError({ message: "The company has no wallet" }),
        );
      const quotes = yield* query(() =>
        tx
          .select({
            id: intentQuotes.id,
            purpose: intentQuotes.purpose,
            status: intentQuotes.status,
            failure: intentQuotes.failure,
          })
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.walletId, wallet.id),
              eq(intentQuotes.purpose, "move_out"),
            ),
          ),
      );
      return {
        ...wallet,
        quotes,
      };
    }),
  );
