import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { ConfidentialSessionError } from "./confidential-account.js";
import type { OneClickSession } from "./one-click.js";
import { wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { ConfidentialAccounts } from "./confidential-account.js";
import { touchesConfidentialAccount } from "./quote-status.js";

export { touchesConfidentialAccount };

/**
 * The session to ask 1Click about a quote with, for callers that may sign in.
 * It is resolved here and handed to `refreshQuoteStatus` and its callers as
 * an argument because those are reachable from staff code, which must not
 * reach the code that signs (`internal-routes.test.ts`).
 *
 * `undefined` for a quote that touches no confidential account: no read, no
 * sign-in. A company with no active wallet cannot have such a quote, so its
 * absence is a defect.
 */
export function sessionForQuote(
  quote: Pick<
    IntentQuote,
    "organizationId" | "depositType" | "recipientType" | "refundType"
  >,
): Effect.Effect<
  OneClickSession | undefined,
  ConfidentialSessionError | DatabaseError,
  ConfidentialAccounts | DatabaseService
> {
  return Effect.gen(function* () {
    if (!touchesConfidentialAccount(quote)) return undefined;
    const [wallet] = yield* withScope(
      { organizationId: quote.organizationId },
      (tx) =>
        query(() =>
          tx
            .select({
              status: wallets.status,
              privyWalletId: wallets.privyWalletId,
              address: wallets.address,
            })
            .from(wallets)
            .where(eq(wallets.organizationId, quote.organizationId)),
        ),
    );
    if (
      wallet?.status !== "active" ||
      wallet.privyWalletId === null ||
      wallet.address === null
    ) {
      return yield* Effect.dieMessage(
        "a quote that touches a confidential account has no active company wallet",
      );
    }
    const accounts = yield* ConfidentialAccounts;
    return yield* accounts.session({
      privyWalletId: wallet.privyWalletId,
      accountId: wallet.address,
    });
  });
}
