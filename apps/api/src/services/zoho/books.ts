import { and, eq, inArray } from "drizzle-orm";
import { Effect, Either, Option, Redacted } from "effect";

import type {
  ChooseZohoOrganization,
  ZohoAccount,
  ZohoAccountsResponse,
  ZohoMapping,
  ZohoOrganization,
  ZohoStatusResponse,
} from "@expendi-business/shared";
import { ZOHO_REQUIRED_CURRENCY } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { AccountingConnectionRow } from "../../db/schema/index.js";
import type { DatabaseError, NotFound } from "../../errors.js";
import type { StaffMember } from "../staff/staff-auth.js";
import type {
  ZohoBooksAccount,
  ZohoBooksSession,
  ZohoError,
} from "./zoho-client.js";
import { accountingConnections, categories } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, ServiceUnavailable } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { ZohoAccessTokens } from "./access-tokens.js";
import {
  ACCOUNTING_CONNECTION,
  inCompany,
  loadOpenConnection,
  noConnection,
  staffActor,
  zohoNotSetUp,
  zohoStatus,
} from "./connections.js";
import { AccountingTokenKey, openToken } from "./token-crypto.js";
import { Zoho } from "./zoho-client.js";

/**
 * Reading the company's Zoho Books (organizations, chart of accounts) and
 * saving the organization and account mapping (spec §6.17).
 */

/** Account types a Zoho expense can be booked to. */
const EXPENSE_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "expense",
  "other_expense",
  "cost_of_goods_sold",
]);

/**
 * Account types offered as Paid Through: where the money came from. Zoho
 * doesn't document which types an expense accepts; confirm against the test
 * organization in QA.
 */
const PAID_THROUGH_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "bank",
  "cash",
  "credit_card",
  "other_current_asset",
  "other_current_liability",
  "equity",
]);

const ZOHO_ACTOR = { type: "system", id: "zoho" } as const;

const zohoRejected = new Conflict({
  message:
    "Zoho no longer accepts this company's connection. Send a new connect link.",
});
const needsReconnect = new Conflict({
  message:
    "Zoho access was lost for this company. Send a new connect link to reconnect.",
});
const notSignedIn = new Conflict({
  message: "Nobody has finished the Zoho sign-in for this company yet.",
});
const chooseOrganizationFirst = new Conflict({
  message: "Choose the company's Zoho organization first.",
});
const connectionChanged = new Conflict({
  message:
    "The Zoho connection changed while you were working. Reload and try again.",
});
const zohoDown = new ServiceUnavailable({
  message: "Zoho didn't answer. Try again in a minute.",
});
const tokenUnreadable = new ServiceUnavailable({
  message:
    "The stored Zoho token can't be read. Send a new connect link to reconnect.",
});

/** A connection someone has signed in on, whose token Zoho hasn't rejected. */
interface SignedInConnection {
  readonly row: AccountingConnectionRow;
  readonly sealedRefreshToken: string;
  readonly accountsServer: string;
}

function signedIn(
  row: AccountingConnectionRow | null,
): Effect.Effect<SignedInConnection, NotFound | Conflict> {
  if (!row) return Effect.fail(noConnection);
  if (row.status === "needs_reconnect") return Effect.fail(needsReconnect);
  if (!row.refreshTokenEncrypted || !row.accountsServer) {
    return Effect.fail(notSignedIn);
  }
  return Effect.succeed({
    row,
    sealedRefreshToken: row.refreshTokenEncrypted,
    accountsServer: row.accountsServer,
  });
}

function withOrganization(
  connection: SignedInConnection,
): Effect.Effect<
  SignedInConnection & { readonly zohoOrganizationId: string },
  Conflict
> {
  const zohoOrganizationId = connection.row.externalOrganizationId;
  return connection.row.status === "active" && zohoOrganizationId
    ? Effect.succeed({ ...connection, zohoOrganizationId })
    : Effect.fail(chooseOrganizationFirst);
}

function loadSignedIn(organizationId: string) {
  return inCompany(organizationId, (tx) =>
    loadOpenConnection(tx, organizationId),
  ).pipe(Effect.flatMap(signedIn));
}

function zohoFailure(error: ZohoError): ServiceUnavailable {
  console.warn(`[zoho] ${error.code}: ${error.message}`);
  return error.code === "NOT_CONFIGURED" ? zohoNotSetUp : zohoDown;
}

/**
 * Zoho rejected the stored token: the connection needs a new sign-in. The
 * dead token is forgotten and the change audited (spec §6.17 "Lost access").
 * Only the token that was rejected is cleared, so a sign-in that finished in
 * the meantime stands.
 */
function markNeedsReconnect(
  connection: SignedInConnection,
  reason: string,
): Effect.Effect<
  void,
  DatabaseError,
  DatabaseService | AuditLog | ZohoAccessTokens
> {
  const { row } = connection;
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const cache = yield* ZohoAccessTokens;
    yield* withScope({ organizationId: row.organizationId }, (tx) =>
      Effect.gen(function* () {
        const [marked] = yield* query(() =>
          tx
            .update(accountingConnections)
            .set({ status: "needs_reconnect", refreshTokenEncrypted: null })
            .where(
              and(
                eq(accountingConnections.id, row.id),
                eq(
                  accountingConnections.refreshTokenEncrypted,
                  connection.sealedRefreshToken,
                ),
                inArray(accountingConnections.status, ["pending", "active"]),
              ),
            )
            .returning({ id: accountingConnections.id }),
        );
        if (!marked) return;
        console.warn(
          `[zoho] connection ${row.id} needs reconnecting: ${reason}`,
        );
        yield* audit.record(tx, {
          actor: ZOHO_ACTOR,
          organizationId: row.organizationId,
          action: "accounting_connection.needs_reconnect",
          entity: { type: ACCOUNTING_CONNECTION, id: row.id },
          before: { status: row.status },
          after: { status: "needs_reconnect", reason },
        });
      }),
    );
    cache.evict(row.id);
  });
}

type RejectionDeps = DatabaseService | AuditLog | ZohoAccessTokens;

/** Maps a failed Zoho call: a rejected token marks the connection first. */
function onZohoFailure(
  connection: SignedInConnection,
  rejected: ZohoError["code"],
  reason: string,
) {
  return (
    error: ZohoError,
  ): Effect.Effect<
    never,
    Conflict | ServiceUnavailable | DatabaseError,
    RejectionDeps
  > =>
    error.code === rejected
      ? markNeedsReconnect(connection, reason).pipe(
          Effect.zipRight(Effect.fail(zohoRejected)),
        )
      : Effect.fail(zohoFailure(error));
}

type SessionDeps =
  Zoho | ZohoAccessTokens | AccountingTokenKey | DatabaseService | AuditLog;

function freshSession(
  connection: SignedInConnection,
): Effect.Effect<
  ZohoBooksSession,
  Conflict | ServiceUnavailable | DatabaseError,
  SessionDeps
> {
  return Effect.gen(function* () {
    const zoho = yield* Zoho;
    const cache = yield* ZohoAccessTokens;
    const key = yield* AccountingTokenKey;
    if (Option.isNone(key)) return yield* zohoNotSetUp;
    const opened = openToken(
      [key.value],
      connection.sealedRefreshToken,
      connection.row.id,
    );
    if (Either.isLeft(opened)) {
      console.warn(
        `[zoho] connection ${connection.row.id}: stored token unreadable (${opened.left})`,
      );
      return yield* tokenUnreadable;
    }
    const token = yield* zoho
      .refreshAccessToken({
        accountsServer: connection.accountsServer,
        refreshToken: Redacted.make(opened.right),
      })
      .pipe(
        Effect.catchAll(
          onZohoFailure(
            connection,
            "INVALID_GRANT",
            "zoho_rejected_refresh_token",
          ),
        ),
      );
    cache.put(connection.row.id, {
      sealedRefreshToken: connection.sealedRefreshToken,
      accessToken: token.accessToken,
      apiDomain: token.apiDomain,
      expiresInSeconds: token.expiresInSeconds,
    });
    return { apiDomain: token.apiDomain, accessToken: token.accessToken };
  });
}

/**
 * Runs a Books call with the connection's access token: the cached one if
 * it's still good, else a fresh one. A cached token Books refuses is
 * replaced once; a fresh one Books refuses means Zoho has rejected the
 * connection.
 */
function withBooksSession<A>(
  connection: SignedInConnection,
  call: (session: ZohoBooksSession) => Effect.Effect<A, ZohoError>,
): Effect.Effect<
  A,
  Conflict | ServiceUnavailable | DatabaseError,
  SessionDeps
> {
  return Effect.gen(function* () {
    const cache = yield* ZohoAccessTokens;
    const cached = cache.get(connection.row.id, connection.sealedRefreshToken);
    if (cached) {
      const outcome = yield* Effect.either(call(cached));
      if (Either.isRight(outcome)) return outcome.right;
      if (outcome.left.code !== "UNAUTHORIZED") {
        return yield* zohoFailure(outcome.left);
      }
      cache.evict(connection.row.id);
    }
    const session = yield* freshSession(connection);
    return yield* call(session).pipe(
      Effect.catchAll(
        onZohoFailure(connection, "UNAUTHORIZED", "zoho_books_refused_access"),
      ),
    );
  });
}

function byName<T extends { readonly name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** `GET /internal/companies/:id/zoho/organizations`. */
export function listZohoOrganizations(
  organizationId: string,
): Effect.Effect<
  ZohoOrganization[],
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  SessionDeps
> {
  return Effect.gen(function* () {
    const zoho = yield* Zoho;
    const connection = yield* loadSignedIn(organizationId);
    const found = yield* withBooksSession(connection, zoho.listOrganizations);
    return byName(found);
  });
}

/**
 * `POST /internal/companies/:id/zoho/organization`. Refused unless the
 * organization keeps its books in KES. Choosing a different organization
 * clears the account mapping, whose accounts belonged to the old one.
 */
export function chooseZohoOrganization(
  staff: StaffMember,
  organizationId: string,
  { externalOrganizationId }: ChooseZohoOrganization,
): Effect.Effect<
  ZohoStatusResponse,
  NotFound | BadRequest | Conflict | ServiceUnavailable | DatabaseError,
  SessionDeps
> {
  return Effect.gen(function* () {
    const zoho = yield* Zoho;
    const audit = yield* AuditLog;
    const connection = yield* loadSignedIn(organizationId);
    const available = yield* withBooksSession(
      connection,
      zoho.listOrganizations,
    );
    const chosen = available.find(({ id }) => id === externalOrganizationId);
    if (!chosen) {
      return yield* new BadRequest({
        message: "That organization isn't in the Zoho account that signed in.",
      });
    }
    if (chosen.currencyCode.toUpperCase() !== ZOHO_REQUIRED_CURRENCY) {
      return yield* new BadRequest({
        message: `${chosen.name} keeps its books in ${chosen.currencyCode}. Expendi only connects Zoho organizations whose base currency is ${ZOHO_REQUIRED_CURRENCY}.`,
      });
    }

    yield* inCompany(organizationId, (tx) =>
      Effect.gen(function* () {
        const current = yield* loadOpenConnection(tx, organizationId, {
          forUpdate: true,
        });
        if (
          current?.id !== connection.row.id ||
          current.refreshTokenEncrypted !== connection.sealedRefreshToken ||
          current.status === "needs_reconnect"
        ) {
          return yield* connectionChanged;
        }
        const switching = current.externalOrganizationId !== chosen.id;
        if (
          !switching &&
          current.externalOrganizationName === chosen.name &&
          current.status === "active"
        ) {
          return;
        }
        yield* query(() =>
          tx
            .update(accountingConnections)
            .set({
              externalOrganizationId: chosen.id,
              externalOrganizationName: chosen.name,
              status: "active",
              ...(switching && {
                paidThroughAccountId: null,
                defaultAccountId: null,
              }),
            })
            .where(eq(accountingConnections.id, current.id)),
        );
        if (switching) {
          yield* query(() =>
            tx
              .update(categories)
              .set({ accountingAccountId: null })
              .where(eq(categories.organizationId, organizationId)),
          );
        }
        yield* audit.record(tx, {
          actor: staffActor(staff),
          organizationId,
          action: "accounting_connection.organization_chosen",
          entity: { type: ACCOUNTING_CONNECTION, id: current.id },
          before: {
            status: current.status,
            externalOrganizationId: current.externalOrganizationId,
            externalOrganizationName: current.externalOrganizationName,
          },
          after: {
            status: "active",
            externalOrganizationId: chosen.id,
            externalOrganizationName: chosen.name,
            currencyCode: chosen.currencyCode,
            mappingCleared: switching,
          },
        });
      }),
    );
    return yield* zohoStatus(organizationId);
  });
}

function toAccount(account: ZohoBooksAccount): ZohoAccount {
  return {
    id: account.id,
    name: account.name,
    code: account.code,
    type: account.type,
  };
}

function classifyAccounts(
  accounts: readonly ZohoBooksAccount[],
): ZohoAccountsResponse {
  return {
    expenseAccounts: byName(
      accounts.filter(({ type }) => EXPENSE_ACCOUNT_TYPES.has(type)),
    ).map(toAccount),
    paidThroughAccounts: byName(
      accounts.filter(({ type }) => PAID_THROUGH_ACCOUNT_TYPES.has(type)),
    ).map(toAccount),
  };
}

function loadChartOfAccounts(organizationId: string) {
  return Effect.gen(function* () {
    const zoho = yield* Zoho;
    const connection = yield* loadSignedIn(organizationId).pipe(
      Effect.flatMap(withOrganization),
    );
    const accounts = yield* withBooksSession(connection, (session) =>
      zoho.listAccounts(session, connection.zohoOrganizationId),
    );
    return { connection, chart: classifyAccounts(accounts) };
  });
}

/** `GET /internal/companies/:id/zoho/accounts`. */
export function listZohoAccounts(
  organizationId: string,
): Effect.Effect<
  ZohoAccountsResponse,
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  SessionDeps
> {
  return Effect.map(loadChartOfAccounts(organizationId), ({ chart }) => chart);
}

/**
 * `PUT /internal/companies/:id/zoho/mapping`. Every account is checked
 * against the organization's chart of accounts as Zoho has it now. Categories
 * left out post to the default account; archived categories are untouched.
 */
export function saveZohoMapping(
  staff: StaffMember,
  organizationId: string,
  mapping: ZohoMapping,
): Effect.Effect<
  ZohoStatusResponse,
  NotFound | BadRequest | Conflict | ServiceUnavailable | DatabaseError,
  SessionDeps
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const companyCategories = yield* inCompany(organizationId, (tx) =>
      query(() =>
        tx
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(
            and(
              eq(categories.organizationId, organizationId),
              eq(categories.archived, false),
            ),
          ),
      ),
    );
    const categoryNames = new Map(
      companyCategories.map(({ id, name }) => [id, name]),
    );
    const mapped = Object.entries(mapping.categoryAccounts);
    if (mapped.some(([categoryId]) => !categoryNames.has(categoryId))) {
      return yield* new BadRequest({
        message: "One of those categories isn't this company's.",
      });
    }

    const { connection, chart } = yield* loadChartOfAccounts(organizationId);
    const expenseIds = new Set(chart.expenseAccounts.map(({ id }) => id));
    const paidThroughIds = new Set(
      chart.paidThroughAccounts.map(({ id }) => id),
    );
    if (!paidThroughIds.has(mapping.paidThroughAccountId)) {
      return yield* new BadRequest({
        message:
          "The Paid Through account must be an active bank, cash or similar account in Zoho.",
      });
    }
    if (!expenseIds.has(mapping.defaultAccountId)) {
      return yield* new BadRequest({
        message:
          "The default account must be an active expense account in Zoho.",
      });
    }
    const badCategory = mapped.find(
      ([, accountId]) => accountId !== null && !expenseIds.has(accountId),
    );
    if (badCategory) {
      return yield* new BadRequest({
        message: `${categoryNames.get(badCategory[0]) ?? "A category"}: pick an active expense account in Zoho.`,
      });
    }

    yield* inCompany(organizationId, (tx) =>
      Effect.gen(function* () {
        const current = yield* loadOpenConnection(tx, organizationId, {
          forUpdate: true,
        });
        if (
          current?.id !== connection.row.id ||
          current.status !== "active" ||
          current.externalOrganizationId !== connection.zohoOrganizationId
        ) {
          return yield* connectionChanged;
        }
        const existing = yield* query(() =>
          tx
            .select({
              id: categories.id,
              accountId: categories.accountingAccountId,
            })
            .from(categories)
            .where(
              and(
                eq(categories.organizationId, organizationId),
                eq(categories.archived, false),
              ),
            ),
        );
        const before = {
          paidThroughAccountId: current.paidThroughAccountId,
          defaultAccountId: current.defaultAccountId,
          categoryAccounts: Object.fromEntries(
            existing.map(({ id, accountId }) => [id, accountId]),
          ),
        };
        const after = {
          paidThroughAccountId: mapping.paidThroughAccountId,
          defaultAccountId: mapping.defaultAccountId,
          categoryAccounts: Object.fromEntries(
            existing.map(({ id }) => [
              id,
              mapping.categoryAccounts[id] ?? null,
            ]),
          ),
        };
        const changedCategories = existing.filter(
          ({ id, accountId }) => after.categoryAccounts[id] !== accountId,
        );
        if (
          changedCategories.length === 0 &&
          before.paidThroughAccountId === after.paidThroughAccountId &&
          before.defaultAccountId === after.defaultAccountId
        ) {
          return;
        }
        for (const { id } of changedCategories) {
          yield* query(() =>
            tx
              .update(categories)
              .set({ accountingAccountId: after.categoryAccounts[id] ?? null })
              .where(eq(categories.id, id)),
          );
        }
        yield* query(() =>
          tx
            .update(accountingConnections)
            .set({
              paidThroughAccountId: after.paidThroughAccountId,
              defaultAccountId: after.defaultAccountId,
            })
            .where(eq(accountingConnections.id, current.id)),
        );
        yield* audit.record(tx, {
          actor: staffActor(staff),
          organizationId,
          action: "accounting_connection.mapping_changed",
          entity: { type: ACCOUNTING_CONNECTION, id: current.id },
          before,
          after,
        });
      }),
    );
    return yield* zohoStatus(organizationId);
  });
}
