import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { Effect, Redacted } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { AccountingConnectionRow } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AccountingTokenKey } from "./token-crypto.js";
import type { Zoho } from "./zoho-client.js";
import { accountingConnections } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  Gone,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { ZohoAccessTokens } from "./access-tokens.js";
import {
  ACCOUNTING_CONNECTION,
  requireZohoSetUp,
  revokeQuietly,
  revokeSealedQuietly,
} from "./connections.js";
import {
  CONNECT_TOKEN_PATTERN,
  hashConnectToken,
  LINK_HASH_PREFIX_LENGTH,
  sealToken,
  signState,
  verifyState,
} from "./token-crypto.js";
import { zohoAccountsServer } from "./zoho-client.js";

/**
 * The public half of connecting (spec §6.17): whoever owns the company's
 * Zoho login opens the connect link, signs in to Zoho and approves access.
 * Neither page needs an Expendi login, so neither says which company a link
 * belongs to: an unknown token, a bad signature and a replaced link all get
 * the same answer.
 */

/** How long the Zoho sign-in may take once the link is opened. */
const STATE_TTL_MS = 15 * 60 * 1000;

const SIGN_IN_ACTOR = { type: "system", id: "zoho-connect-link" } as const;

const linkInvalid = new NotFound({
  message: "This connect link isn't valid. Ask Expendi for a new one.",
});
const linkUsed = new Gone({
  message:
    "This connect link has already been used. Ask Expendi for a new one if you need to connect again.",
});
const linkExpired = new Gone({
  message: "This connect link has expired. Ask Expendi for a new one.",
});
const signInInvalid = new BadRequest({
  message:
    "This Zoho sign-in isn't valid or took too long. Open your connect link again.",
});
const accessDenied = new BadRequest({
  message:
    "Zoho access wasn't allowed, so nothing was connected. Open your connect link again to retry.",
});
const unknownAccountsServer = new BadRequest({
  message:
    "Zoho sent the sign-in back from a server Expendi doesn't recognise. Open your connect link again.",
});
const codeRefused = new BadRequest({
  message: "Zoho didn't accept the sign-in. Open your connect link again.",
});
const zohoUnreachable = new ServiceUnavailable({
  message: "Couldn't reach Zoho. Open your connect link again in a minute.",
});

interface ConnectionRef extends Record<string, unknown> {
  readonly connection_id: string;
  readonly organization_id: string;
}

function loadConnection(
  organizationId: string,
  connectionId: string,
): Effect.Effect<
  AccountingConnectionRow | null,
  DatabaseError,
  DatabaseService
> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(accountingConnections)
        .where(eq(accountingConnections.id, connectionId))
        .limit(1),
    ),
  ).pipe(Effect.map(([row]) => row ?? null));
}

/**
 * `GET /integrations/zoho/connect?token=…`. Checks the link is unused and
 * unexpired, then returns Zoho's sign-in URL with a signed state that names
 * the connection. Opening the link doesn't spend it: only a finished
 * sign-in does, so someone who closes Zoho's page can open the link again.
 */
export function startZohoSignIn(
  token: string,
): Effect.Effect<
  string,
  NotFound | Gone | ServiceUnavailable | DatabaseError,
  DatabaseService | Zoho | AccountingTokenKey
> {
  return Effect.gen(function* () {
    const { zoho, key } = yield* requireZohoSetUp;
    if (!CONNECT_TOKEN_PATTERN.test(token)) return yield* linkInvalid;
    const tokenHash = hashConnectToken(token);

    const [ref] = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<ConnectionRef>(
          sql`SELECT connection_id, organization_id FROM accounting_connection_by_connect_token(${tokenHash})`,
        ),
      ),
    ).pipe(Effect.map(({ rows }) => rows));
    if (!ref) return yield* linkInvalid;

    const row = yield* loadConnection(ref.organization_id, ref.connection_id);
    if (row?.connectTokenHash !== tokenHash) return yield* linkInvalid;
    if (row.connectTokenUsedAt) return yield* linkUsed;
    const now = Date.now();
    if ((row.connectTokenExpiresAt?.getTime() ?? 0) <= now) {
      return yield* linkExpired;
    }

    const state = signState(key, {
      connectionId: row.id,
      organizationId: row.organizationId,
      linkHashPrefix: tokenHash.slice(0, LINK_HASH_PREFIX_LENGTH),
      expiresAt: new Date(now + STATE_TTL_MS),
    });
    return yield* zoho
      .authorizeUrl(state)
      .pipe(Effect.mapError(() => zohoUnreachable));
  });
}

export interface ZohoCallback {
  readonly state: string | undefined;
  readonly code: string | undefined;
  /** Zoho's `accounts-server`: the data centre the person signed in on. */
  readonly accountsServer: string | undefined;
  /** Set instead of a code when the person declined, e.g. `access_denied`. */
  readonly error: string | undefined;
}

/**
 * `GET /integrations/zoho/callback`. Exchanges the code at the accounts
 * server Zoho named, seals the refresh token and spends the link, all or
 * nothing. A connection that already has an organization (a reconnect)
 * only takes a login that can still see that organization, so its mapping
 * stays valid. The token this replaces is revoked afterwards.
 */
export function completeZohoSignIn(
  callback: ZohoCallback,
): Effect.Effect<
  void,
  BadRequest | Conflict | Gone | ServiceUnavailable | DatabaseError,
  DatabaseService | Zoho | AccountingTokenKey | AuditLog | ZohoAccessTokens
> {
  return Effect.gen(function* () {
    const { zoho, key } = yield* requireZohoSetUp;
    const audit = yield* AuditLog;
    const cache = yield* ZohoAccessTokens;

    const state = callback.state
      ? verifyState(key, callback.state, new Date())
      : null;
    if (!state) return yield* signInInvalid;
    if (callback.error !== undefined) return yield* accessDenied;
    if (!callback.code) return yield* signInInvalid;
    const accountsServer = zohoAccountsServer(callback.accountsServer ?? "");
    if (!accountsServer) return yield* unknownAccountsServer;

    const row = yield* loadConnection(state.organizationId, state.connectionId);
    if (
      !row ||
      row.status === "disconnected" ||
      !row.connectTokenHash?.startsWith(state.linkHashPrefix)
    ) {
      return yield* signInInvalid;
    }
    if (row.connectTokenUsedAt) return yield* linkUsed;

    const grant = yield* zoho
      .exchangeCode({ accountsServer, code: callback.code })
      .pipe(
        Effect.mapError((error) => {
          console.warn(
            `[zoho] connection ${row.id}: sign-in failed (${error.code}): ${error.message}`,
          );
          return error.code === "INVALID_GRANT" ? codeRefused : zohoUnreachable;
        }),
      );
    const discardGrant = revokeQuietly(
      row.id,
      grant.refreshToken,
      accountsServer,
    );

    if (row.externalOrganizationId) {
      const visible = yield* zoho
        .listOrganizations({
          apiDomain: grant.apiDomain,
          accessToken: grant.accessToken,
        })
        .pipe(
          Effect.tapError(() => discardGrant),
          Effect.mapError(() => zohoUnreachable),
        );
      if (!visible.some(({ id }) => id === row.externalOrganizationId)) {
        yield* discardGrant;
        return yield* new Conflict({
          message: `This Zoho login can't see ${row.externalOrganizationName ?? "the organization"}, the organization Expendi is connected to. Sign in with a Zoho login that can.`,
        });
      }
    }

    const sealed = sealToken(key, Redacted.value(grant.refreshToken), row.id);
    const status = row.externalOrganizationId ? "active" : "pending";
    const now = new Date();
    const stored = yield* withScope(
      { organizationId: row.organizationId },
      (tx) =>
        Effect.gen(function* () {
          const [spent] = yield* query(() =>
            tx
              .update(accountingConnections)
              .set({
                refreshTokenEncrypted: sealed,
                accountsServer,
                apiDomain: grant.apiDomain,
                connectedAt: now,
                connectTokenUsedAt: now,
                status,
              })
              .where(
                and(
                  eq(accountingConnections.id, row.id),
                  eq(
                    accountingConnections.connectTokenHash,
                    row.connectTokenHash ?? "",
                  ),
                  isNull(accountingConnections.connectTokenUsedAt),
                  ne(accountingConnections.status, "disconnected"),
                ),
              )
              .returning({ id: accountingConnections.id }),
          );
          if (!spent) return false;
          yield* audit.record(tx, {
            actor: SIGN_IN_ACTOR,
            organizationId: row.organizationId,
            action: "accounting_connection.connected",
            entity: { type: ACCOUNTING_CONNECTION, id: row.id },
            before: {
              status: row.status,
              connectedAt: row.connectedAt,
              accountsServer: row.accountsServer,
            },
            after: {
              status,
              connectedAt: now,
              accountsServer,
              apiDomain: grant.apiDomain,
            },
          });
          return true;
        }),
    );
    if (!stored) {
      yield* discardGrant;
      return yield* linkUsed;
    }

    cache.put(row.id, {
      sealedRefreshToken: sealed,
      accessToken: grant.accessToken,
      apiDomain: grant.apiDomain,
      expiresInSeconds: grant.expiresInSeconds,
    });
    if (row.refreshTokenEncrypted && row.accountsServer) {
      yield* revokeSealedQuietly(
        row.id,
        row.refreshTokenEncrypted,
        row.accountsServer,
      );
    }
  });
}
