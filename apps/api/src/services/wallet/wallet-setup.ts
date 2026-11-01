import { Cause, Effect, Exit } from "effect";

import type { WalletSetup } from "@expendi-business/shared";

import type { Wallet } from "../../db/schema/index.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { EnsureCompanyWalletDeps } from "./company-wallet.js";
import { ensureCompanyWallet } from "./company-wallet.js";

const notReady: WalletSetup = { status: "creating", address: null };

/** Ready for deposits: it exists in Privy and Alchemy watches its address. */
export function readyAddress(
  wallet: Pick<Wallet, "status" | "address" | "depositsWatchedAt">,
): string | null {
  return wallet.status === "active" && wallet.depositsWatchedAt !== null
    ? wallet.address
    : null;
}

/**
 * `ensureCompanyWallet` for a company that already exists, reporting whether
 * the wallet is ready instead of failing: the company stands either way, and
 * calling this again resumes the setup where it stopped.
 */
export function setUpCompanyWallet(input: {
  readonly organizationId: string;
  readonly actor: AuditActor;
}): Effect.Effect<WalletSetup, never, EnsureCompanyWalletDeps> {
  return Effect.exit(ensureCompanyWallet(input)).pipe(
    Effect.map((exit): WalletSetup => {
      if (Exit.isFailure(exit)) {
        console.error(
          `[wallet] setup for company ${input.organizationId} stopped; it resumes on the next attempt`,
          Cause.pretty(exit.cause),
        );
        return notReady;
      }
      const address = readyAddress(exit.value);
      return address === null ? notReady : { status: "active", address };
    }),
  );
}
