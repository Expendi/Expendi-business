import { and, eq, ne, sql } from "drizzle-orm";
import { Effect, Either, Option, Redacted } from "effect";

import type {
  ZohoConnection,
  ZohoConnectLinkResponse,
  ZohoStatusResponse,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { AccountingConnectionRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { StaffMember } from "../staff/staff-auth.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import {
  accountingConnections,
  categories,
  organizations,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  Conflict,
  DatabaseError,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { ZohoAccessTokens } from "./access-tokens.js";
import {
  AccountingTokenKey,
  hashConnectToken,
  newConnectToken,
  openToken,
} from "./token-crypto.js";
import { Zoho } from "./zoho-client.js";

/**
 * A company's Zoho Books connection as staff manage it (spec §6.15, §6.17).
 *
 * Staff are allowed every company, so each request narrows itself to the one
 * company in its path: the work runs in that company's database scope, and
 * row-level security keeps every read and write, the audit entry included,
 * inside it. Zoho is never called inside a transaction; a write after a Zoho
 * call re-checks the row it read first.
 */

export const CONNECT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ACCOUNTING_CONNECTION = "accounting_connection";

export const zohoNotSetUp = new ServiceUnavailable({
  message: "Zoho isn't set up",
});

const noCompany = new NotFound({ message: "No company with that ID" });

export const noConnection = new NotFound({
  message: "This company has no Zoho connection",
});

const linkClash = new Conflict({
  message:
    "Someone else just changed this company's Zoho connection. Reload and try again.",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const staffActor = (staff: StaffMember): AuditActor => ({
  type: "staff",
  id: staff.staffUserId,
});

/**
 * Runs `work` in the company's scope once `organizationId` is known to name
 * a company. A malformed or unknown ID is a 404 either way.
 */
export function inCompany<A, E, R>(
  organizationId: string,
  work: (tx: Transaction) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | NotFound | DatabaseError, R | DatabaseService> {
  if (!UUID.test(organizationId)) return Effect.fail(noCompany);
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1),
    ).pipe(
      Effect.flatMap(([company]): Effect.Effect<A, E | NotFound, R> =>
        company ? work(tx) : Effect.fail(noCompany),
      ),
    ),
  );
}

/** The company's connection that isn't disconnected, locked when `forUpdate`. */
export function loadOpenConnection(
  tx: Transaction,
  organizationId: string,
  { forUpdate = false }: { readonly forUpdate?: boolean } = {},
): Effect.Effect<AccountingConnectionRow | null, DatabaseError> {
  return query(() => {
    const select = tx
      .select()
      .from(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          ne(accountingConnections.status, "disconnected"),
        ),
      )
      .limit(1);
    return forUpdate ? select.for("update") : select;
  }).pipe(Effect.map(([row]) => row ?? null));
}

function describeConnection(
  tx: Transaction,
  row: AccountingConnectionRow,
  now: Date,
): Effect.Effect<ZohoConnection, DatabaseError> {
  return query(() =>
    tx
      .select({
        id: categories.id,
        name: categories.name,
        accountId: categories.accountingAccountId,
      })
      .from(categories)
      .where(
        and(
          eq(categories.organizationId, row.organizationId),
          eq(categories.archived, false),
        ),
      )
      .orderBy(sql`lower(${categories.name}) COLLATE "C"`, categories.id),
  ).pipe(
    Effect.map((companyCategories) => ({
      id: row.id,
      status: row.status,
      connectedAt: row.connectedAt?.toISOString() ?? null,
      connectLink:
        row.connectTokenExpiresAt && !row.connectTokenUsedAt
          ? {
              expiresAt: row.connectTokenExpiresAt.toISOString(),
              expired: row.connectTokenExpiresAt.getTime() <= now.getTime(),
            }
          : null,
      organization: row.externalOrganizationId
        ? {
            id: row.externalOrganizationId,
            name: row.externalOrganizationName ?? row.externalOrganizationId,
          }
        : null,
      apiDomain: row.apiDomain,
      paidThroughAccountId: row.paidThroughAccountId,
      defaultAccountId: row.defaultAccountId,
      categoryAccounts: companyCategories.map((category) => ({
        categoryId: category.id,
        categoryName: category.name,
        accountId: category.accountId,
      })),
    })),
  );
}

/** `GET /internal/companies/:id/zoho`. Never includes a token or its hash. */
export function zohoStatus(
  organizationId: string,
): Effect.Effect<
  ZohoStatusResponse,
  NotFound | DatabaseError,
  DatabaseService | Zoho | AccountingTokenKey
> {
  return Effect.gen(function* () {
    const zoho = yield* Zoho;
    const key = yield* AccountingTokenKey;
    const now = new Date();
    const connection = yield* inCompany(organizationId, (tx) =>
      Effect.flatMap(loadOpenConnection(tx, organizationId), (row) =>
        row ? describeConnection(tx, row, now) : Effect.succeed(null),
      ),
    );
    return { configured: zoho.configured && Option.isSome(key), connection };
  });
}

/** Zoho and the token key are both set up; otherwise a 503. */
export const requireZohoSetUp = Effect.gen(function* () {
  const zoho = yield* Zoho;
  const key = yield* AccountingTokenKey;
  if (!zoho.configured || Option.isNone(key)) return yield* zohoNotSetUp;
  return { zoho, key: key.value };
});

function isOpenConnectionClash(error: DatabaseError): boolean {
  return (
    violatedUniqueConstraint(error.cause) ===
    "accounting_connections_one_open_per_organization"
  );
}

/**
 * `POST /internal/companies/:id/zoho/connect-link`. Puts a new link on the
 * company's open connection, or starts a pending one, and returns its URL
 * this once: only the token's hash is stored. The link replaces any earlier
 * one. On a connection that's already signed in it re-runs the sign-in and
 * keeps the chosen organization and mapping, which is how a connection that
 * needs reconnecting is fixed.
 */
export function createConnectLink(
  staff: StaffMember,
  organizationId: string,
): Effect.Effect<
  ZohoConnectLinkResponse,
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | Zoho | AccountingTokenKey | AuditLog
> {
  return Effect.gen(function* () {
    const { zoho } = yield* requireZohoSetUp;
    const audit = yield* AuditLog;
    const token = newConnectToken();
    const url = yield* zoho
      .connectLinkUrl(token)
      .pipe(Effect.mapError(() => zohoNotSetUp));
    const expiresAt = new Date(Date.now() + CONNECT_LINK_TTL_MS);
    const link = {
      connectTokenHash: hashConnectToken(token),
      connectTokenExpiresAt: expiresAt,
      connectTokenUsedAt: null,
    };

    yield* inCompany(organizationId, (tx) =>
      Effect.gen(function* () {
        const existing = yield* loadOpenConnection(tx, organizationId, {
          forUpdate: true,
        });
        const [saved] = yield* query(() =>
          existing
            ? tx
                .update(accountingConnections)
                .set(link)
                .where(eq(accountingConnections.id, existing.id))
                .returning({
                  id: accountingConnections.id,
                  status: accountingConnections.status,
                })
            : tx
                .insert(accountingConnections)
                .values({ organizationId, ...link })
                .returning({
                  id: accountingConnections.id,
                  status: accountingConnections.status,
                }),
        );
        if (!saved) {
          return yield* Effect.fail(
            new DatabaseError({
              message: "connect link write returned no row",
              cause: null,
            }),
          );
        }
        yield* audit.record(tx, {
          actor: staffActor(staff),
          organizationId,
          action: "accounting_connection.connect_link_created",
          entity: { type: ACCOUNTING_CONNECTION, id: saved.id },
          before: existing
            ? {
                status: existing.status,
                connectLinkExpiresAt: existing.connectTokenExpiresAt,
              }
            : null,
          after: { status: saved.status, connectLinkExpiresAt: expiresAt },
        });
      }),
    ).pipe(
      Effect.catchIf(
        (error): error is DatabaseError =>
          error instanceof DatabaseError && isOpenConnectionClash(error),
        () => Effect.fail(linkClash),
      ),
    );

    return { url, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * Revokes a sealed refresh token at Zoho, best effort: whatever goes wrong
 * is logged without the token and reported as `false`.
 */
export function revokeSealedQuietly(
  connectionId: string,
  sealed: string,
  accountsServer: string,
): Effect.Effect<boolean, never, Zoho | AccountingTokenKey> {
  return Effect.gen(function* () {
    const key = yield* AccountingTokenKey;
    if (Option.isNone(key)) return false;
    const opened = openToken([key.value], sealed, connectionId);
    if (Either.isLeft(opened)) {
      console.warn(
        `[zoho] connection ${connectionId}: stored token unreadable (${opened.left}), not revoked`,
      );
      return false;
    }
    return yield* revokeQuietly(
      connectionId,
      Redacted.make(opened.right),
      accountsServer,
    );
  });
}

export function revokeQuietly(
  connectionId: string,
  token: Redacted.Redacted,
  accountsServer: string,
): Effect.Effect<boolean, never, Zoho> {
  return Effect.flatMap(Zoho, (zoho) =>
    zoho.revokeToken({ accountsServer, token }).pipe(
      Effect.as(true),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn(
            `[zoho] connection ${connectionId}: revoking failed (${error.code}): ${error.message}`,
          );
          return false;
        }),
      ),
    ),
  );
}

/**
 * `POST /internal/companies/:id/zoho/disconnect`. Revokes the token at Zoho
 * (best effort), then forgets it and the connect link. The row stays, as
 * `disconnected`, for history; the category mapping stays on the
 * categories until an organization is chosen on a new connection.
 */
export function disconnectZoho(
  staff: StaffMember,
  organizationId: string,
): Effect.Effect<
  ZohoStatusResponse,
  NotFound | DatabaseError,
  DatabaseService | Zoho | AccountingTokenKey | AuditLog | ZohoAccessTokens
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const cache = yield* ZohoAccessTokens;
    const row = yield* inCompany(organizationId, (tx) =>
      loadOpenConnection(tx, organizationId),
    );
    if (!row) return yield* noConnection;

    const revokedAtZoho =
      row.refreshTokenEncrypted && row.accountsServer
        ? yield* revokeSealedQuietly(
            row.id,
            row.refreshTokenEncrypted,
            row.accountsServer,
          )
        : false;

    yield* inCompany(organizationId, (tx) =>
      Effect.gen(function* () {
        const [disconnected] = yield* query(() =>
          tx
            .update(accountingConnections)
            .set({
              status: "disconnected",
              refreshTokenEncrypted: null,
              connectTokenHash: null,
              connectTokenExpiresAt: null,
            })
            .where(
              and(
                eq(accountingConnections.id, row.id),
                ne(accountingConnections.status, "disconnected"),
              ),
            )
            .returning({ id: accountingConnections.id }),
        );
        if (!disconnected) return yield* noConnection;
        yield* audit.record(tx, {
          actor: staffActor(staff),
          organizationId,
          action: "accounting_connection.disconnected",
          entity: { type: ACCOUNTING_CONNECTION, id: row.id },
          before: {
            status: row.status,
            externalOrganizationId: row.externalOrganizationId,
          },
          after: { status: "disconnected", revokedAtZoho },
        });
      }),
    );
    cache.evict(row.id);
    return yield* zohoStatus(organizationId);
  });
}
