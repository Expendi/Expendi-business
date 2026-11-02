import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

/**
 * Zoho's OAuth 2.0 and Books API v3 (spec §6.17), checked against Zoho's
 * docs:
 *   - sign-in and tokens: https://www.zoho.com/accounts/protocol/oauth/web-apps/authorization.html
 *     and …/access-token.html, …/access-token-expiry.html
 *   - data centres: https://www.zoho.com/accounts/protocol/oauth/multi-dc.html
 *   - scopes and revoking: https://www.zoho.com/books/api/v3/oauth/
 *   - https://www.zoho.com/books/api/v3/organizations/ and …/chart-of-accounts/
 *   - https://www.zoho.com/books/api/v3/expenses/: create, list by
 *     `reference_number`, and "Add receipt to an expense" (`receipt`, scope
 *     ZohoBooks.expenses.CREATE)
 *   - limits: https://www.zoho.com/books/api/v3/introduction/ (HTTP 429)
 *
 * Zoho runs several data centres. Sign-in starts at accounts.zoho.com; the
 * callback names the person's accounts server and the token reply names the
 * API domain, and every later call goes to those. Both are checked against
 * Zoho's hosts first, since the callback's `accounts-server` comes through
 * the browser and the client secret must never go anywhere else.
 *
 * Tokens travel as `Redacted` and never appear in an error message, so
 * errors can be logged as they are.
 */

export type ZohoErrorCode =
  /** ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET or ZOHO_REDIRECT_URI isn't set. */
  | "NOT_CONFIGURED"
  /** Zoho rejected the code or the refresh token (`invalid_code`): sign in again. */
  | "INVALID_GRANT"
  /** Books refused the access token (HTTP 401). */
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "API_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

export class ZohoError extends Data.TaggedError("ZohoError")<{
  readonly message: string;
  readonly code: ZohoErrorCode;
}> {}

/**
 * Only what §6.17 needs: read organizations, read the chart of accounts,
 * create and read expenses.
 */
export const ZOHO_SCOPES = [
  "ZohoBooks.settings.READ",
  "ZohoBooks.accountants.READ",
  "ZohoBooks.expenses.CREATE",
  "ZohoBooks.expenses.READ",
] as const;

/** Where every sign-in starts; Zoho sends people on to their own data centre. */
const ZOHO_SIGN_IN_ORIGIN = "https://accounts.zoho.com";

/** Zoho's accounts servers, from its Multi-DC page. */
const ACCOUNTS_HOSTS: ReadonlySet<string> = new Set([
  "accounts.zoho.com",
  "accounts.zoho.eu",
  "accounts.zoho.in",
  "accounts.zoho.com.au",
  "accounts.zoho.jp",
  "accounts.zohocloud.ca",
  "accounts.zoho.sa",
  "accounts.zoho.uk",
]);

/** Books API domains, from the Books API introduction: www.zohoapis.<data centre>. */
const API_DOMAIN_HOST =
  /^www\.zohoapis\.(com|eu|in|com\.au|jp|ca|com\.cn|sa|ae)$/;

function httpsOrigin(raw: string, accept: (host: string) => boolean) {
  try {
    const url = new URL(raw);
    const bare =
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "";
    return bare && accept(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The accounts server as an origin, if it's one of Zoho's. */
export function zohoAccountsServer(raw: string): string | null {
  return httpsOrigin(raw, (host) => ACCOUNTS_HOSTS.has(host));
}

/** The Books API domain as an origin, if it's one of Zoho's. */
export function zohoApiDomain(raw: string): string | null {
  return httpsOrigin(raw, (host) => API_DOMAIN_HOST.test(host));
}

export interface ZohoGrant {
  readonly refreshToken: Redacted.Redacted;
  readonly accessToken: Redacted.Redacted;
  readonly apiDomain: string;
  readonly expiresInSeconds: number;
}

export interface ZohoAccessToken {
  readonly accessToken: Redacted.Redacted;
  readonly apiDomain: string;
  readonly expiresInSeconds: number;
}

export interface ZohoBooksOrganization {
  readonly id: string;
  readonly name: string;
  readonly currencyCode: string;
}

export interface ZohoBooksAccount {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  /** Zoho's `account_type`, e.g. `expense`, `bank`, `cash`. */
  readonly type: string;
}

export interface ZohoBooksSession {
  readonly apiDomain: string;
  readonly accessToken: Redacted.Redacted;
}

/** One Zoho expense as Expendi posts it (spec §6.17). */
export interface ZohoExpenseDraft {
  readonly accountId: string;
  readonly paidThroughAccountId: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  /** KES with exactly two decimals, e.g. "1500.50", from integer cents. */
  readonly amount: string;
  /** Up to 100 characters; Expendi's ID for what's posted. */
  readonly referenceNumber: string;
  /** Up to 100 characters. */
  readonly description: string;
}

export interface ZohoExpense {
  readonly id: string;
  readonly referenceNumber: string | null;
  readonly hasReceipt: boolean;
}

export interface ZohoReceiptFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly fileName: string;
}

export interface ZohoShape {
  /** False when the Zoho client settings are missing and every call fails. */
  readonly configured: boolean;
  /** Zoho's sign-in page, asking for a refresh token and `ZOHO_SCOPES`. */
  readonly authorizeUrl: (state: string) => Effect.Effect<string, ZohoError>;
  /** The API's own connect page for a link token, beside the registered callback. */
  readonly connectLinkUrl: (token: string) => Effect.Effect<string, ZohoError>;
  readonly exchangeCode: (input: {
    readonly accountsServer: string;
    readonly code: string;
  }) => Effect.Effect<ZohoGrant, ZohoError>;
  readonly refreshAccessToken: (input: {
    readonly accountsServer: string;
    readonly refreshToken: Redacted.Redacted;
  }) => Effect.Effect<ZohoAccessToken, ZohoError>;
  readonly revokeToken: (input: {
    readonly accountsServer: string;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<void, ZohoError>;
  readonly listOrganizations: (
    session: ZohoBooksSession,
  ) => Effect.Effect<readonly ZohoBooksOrganization[], ZohoError>;
  /** Every active account in the organization's chart of accounts. */
  readonly listAccounts: (
    session: ZohoBooksSession,
    organizationId: string,
  ) => Effect.Effect<readonly ZohoBooksAccount[], ZohoError>;
  /** Every expense whose reference number is exactly `referenceNumber`. */
  readonly findExpenses: (
    session: ZohoBooksSession,
    organizationId: string,
    referenceNumber: string,
  ) => Effect.Effect<readonly ZohoExpense[], ZohoError>;
  readonly createExpense: (
    session: ZohoBooksSession,
    organizationId: string,
    draft: ZohoExpenseDraft,
  ) => Effect.Effect<ZohoExpense, ZohoError>;
  readonly attachReceipt: (
    session: ZohoBooksSession,
    organizationId: string,
    expenseId: string,
    file: ZohoReceiptFile,
  ) => Effect.Effect<void, ZohoError>;
}

export class Zoho extends Context.Tag("Zoho")<Zoho, ZohoShape>() {}

export interface ZohoSettings {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  /** The API's `/integrations/zoho/callback`, as registered with Zoho. */
  readonly redirectUri: string;
}

const REQUEST_TIMEOUT_MS = 20_000;
const ACCOUNTS_PAGE_SIZE = 200;
const MAX_ACCOUNT_PAGES = 25;
const EXPENSE_SEARCH_PAGE_SIZE = 25;

const zohoId = z.union([z.string().min(1), z.number().int()]).transform(String);

const tokenReplySchema = z.looseObject({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  api_domain: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  error: z.string().optional(),
});

const booksReplySchema = z.looseObject({
  code: z.number().int(),
  message: z.string().optional(),
});

const expenseReplySchema = z.looseObject({
  expense_id: zohoId,
  reference_number: z.string().nullish(),
  /** Blank when the expense has no receipt. */
  expense_receipt_name: z.string().nullish(),
});

const expensesReplySchema = z.looseObject({
  expenses: z.array(expenseReplySchema),
  page_context: z
    .looseObject({ has_more_page: z.boolean().optional() })
    .optional(),
});

const createdExpenseReplySchema = z.looseObject({
  expense: expenseReplySchema,
});

function toExpense(reply: z.infer<typeof expenseReplySchema>): ZohoExpense {
  return {
    id: reply.expense_id,
    referenceNumber: reply.reference_number ?? null,
    hasReceipt: (reply.expense_receipt_name ?? "").trim() !== "",
  };
}

const KES_AMOUNT = /^\d+\.\d{2}$/;

/**
 * Books' JSON body for a new expense. The amount goes in as a JSON number
 * spliced from its decimal text, so it never passes through a float here.
 */
function expenseBody(draft: ZohoExpenseDraft): string | null {
  if (!KES_AMOUNT.test(draft.amount)) return null;
  const fields = JSON.stringify({
    account_id: draft.accountId,
    paid_through_account_id: draft.paidThroughAccountId,
    date: draft.date,
    reference_number: draft.referenceNumber,
    description: draft.description,
  });
  return `${fields.slice(0, -1)},"amount":${draft.amount}}`;
}

/** Zoho's own explanation of a refusal, shortened for logs and staff. */
const MAX_ZOHO_MESSAGE_LENGTH = 200;

const organizationsReplySchema = z.looseObject({
  organizations: z.array(
    z.looseObject({
      organization_id: zohoId,
      name: z.string(),
      currency_code: z.string(),
    }),
  ),
});

const accountsReplySchema = z.looseObject({
  chartofaccounts: z.array(
    z.looseObject({
      account_id: zohoId,
      account_name: z.string(),
      account_code: z.string().nullish(),
      account_type: z.string(),
      is_active: z.boolean().optional(),
    }),
  ),
  page_context: z
    .looseObject({ has_more_page: z.boolean().optional() })
    .optional(),
});

const fail = (code: ZohoErrorCode, message: string) =>
  Effect.fail(new ZohoError({ code, message }));

/** Zoho's token errors that mean the code or refresh token is no good. */
const DEAD_GRANT_ERRORS = new Set(["invalid_code", "invalid_grant"]);

export function makeZohoClient(
  settings: ZohoSettings,
  fetchImpl: typeof fetch = fetch,
): ZohoShape {
  const send = (
    label: string,
    url: URL,
    init: RequestInit,
  ): Effect.Effect<
    { readonly status: number; readonly body: unknown },
    ZohoError
  > =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
      },
      catch: () =>
        new ZohoError({
          code: "NETWORK_ERROR",
          message: `Zoho ${label} unreachable`,
        }),
    });

  const tokenCall = (
    label: string,
    accountsServer: string,
    path: string,
    params: Record<string, string>,
  ) =>
    Effect.gen(function* () {
      const origin = zohoAccountsServer(accountsServer);
      if (!origin) {
        return yield* fail(
          "API_ERROR",
          `Zoho ${label}: not a Zoho accounts server`,
        );
      }
      // Zoho documents these parameters in the query string.
      const url = new URL(path, origin);
      for (const [name, value] of Object.entries(params)) {
        url.searchParams.set(name, value);
      }
      const reply = yield* send(label, url, { method: "POST" });
      const parsed = tokenReplySchema.safeParse(reply.body);
      const zohoError = parsed.success ? parsed.data.error : undefined;
      if (
        reply.status === 401 ||
        (zohoError !== undefined && DEAD_GRANT_ERRORS.has(zohoError))
      ) {
        return yield* fail(
          "INVALID_GRANT",
          `Zoho ${label}: ${zohoError ?? "HTTP 401"}`,
        );
      }
      if (reply.status === 429) {
        return yield* fail("RATE_LIMITED", `Zoho ${label}: HTTP 429`);
      }
      if (reply.status < 200 || reply.status >= 300 || zohoError) {
        return yield* fail(
          "API_ERROR",
          `Zoho ${label}: ${zohoError ?? `HTTP ${reply.status}`}`,
        );
      }
      return parsed.success ? parsed.data : null;
    });

  const accessTokenFrom = (
    label: string,
    reply: z.infer<typeof tokenReplySchema> | null,
  ) => {
    const apiDomain = reply?.api_domain
      ? zohoApiDomain(reply.api_domain)
      : null;
    if (!reply?.access_token || !apiDomain) {
      return fail(
        "INVALID_RESPONSE",
        `Zoho ${label}: no access token or Books API domain`,
      );
    }
    return Effect.succeed({
      accessToken: Redacted.make(reply.access_token),
      apiDomain,
      expiresInSeconds: reply.expires_in ?? 3600,
    });
  };

  const books = <T>(
    label: string,
    session: ZohoBooksSession,
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
    request: {
      readonly method: "GET" | "POST";
      readonly body?: string | FormData;
    } = { method: "GET" },
  ) =>
    Effect.gen(function* () {
      const origin = zohoApiDomain(session.apiDomain);
      if (!origin) {
        return yield* fail("API_ERROR", `Zoho ${label}: not a Zoho API domain`);
      }
      const url = new URL(`/books/v3${path}`, origin);
      for (const [name, value] of Object.entries(params)) {
        url.searchParams.set(name, value);
      }
      const reply = yield* send(label, url, {
        method: request.method,
        headers: {
          Authorization: `Zoho-oauthtoken ${Redacted.value(session.accessToken)}`,
          Accept: "application/json",
          ...(typeof request.body === "string" && {
            "Content-Type": "application/json",
          }),
        },
        body: request.body,
      });
      const envelope = booksReplySchema.safeParse(reply.body);
      const zohoMessage = envelope.success
        ? envelope.data.message?.slice(0, MAX_ZOHO_MESSAGE_LENGTH)
        : undefined;
      const booksCode = envelope.success
        ? ` (code ${envelope.data.code}${zohoMessage ? `: ${zohoMessage}` : ""})`
        : "";
      if (reply.status === 401) {
        return yield* fail(
          "UNAUTHORIZED",
          `Zoho ${label}: HTTP 401${booksCode}`,
        );
      }
      if (reply.status === 429) {
        return yield* fail("RATE_LIMITED", `Zoho ${label}: HTTP 429`);
      }
      if (
        reply.status < 200 ||
        reply.status >= 300 ||
        !envelope.success ||
        envelope.data.code !== 0
      ) {
        return yield* fail(
          "API_ERROR",
          `Zoho ${label}: HTTP ${reply.status}${booksCode}`,
        );
      }
      const parsed = schema.safeParse(reply.body);
      return parsed.success
        ? parsed.data
        : yield* fail("INVALID_RESPONSE", `Zoho ${label}: unexpected reply`);
    });

  return {
    configured: true,
    authorizeUrl: (state) => {
      const url = new URL("/oauth/v2/auth", ZOHO_SIGN_IN_ORIGIN);
      url.searchParams.set("scope", ZOHO_SCOPES.join(","));
      url.searchParams.set("client_id", settings.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("redirect_uri", settings.redirectUri);
      url.searchParams.set("state", state);
      return Effect.succeed(url.href);
    },
    connectLinkUrl: (token) => {
      const url = new URL("connect", settings.redirectUri);
      url.searchParams.set("token", token);
      return Effect.succeed(url.href);
    },
    exchangeCode: ({ accountsServer, code }) =>
      tokenCall("token exchange", accountsServer, "/oauth/v2/token", {
        grant_type: "authorization_code",
        client_id: settings.clientId,
        client_secret: Redacted.value(settings.clientSecret),
        redirect_uri: settings.redirectUri,
        code,
      }).pipe(
        Effect.flatMap((reply) =>
          Effect.flatMap(
            accessTokenFrom("token exchange", reply),
            (access): Effect.Effect<ZohoGrant, ZohoError> =>
              reply?.refresh_token
                ? Effect.succeed({
                    ...access,
                    refreshToken: Redacted.make(reply.refresh_token),
                  })
                : fail(
                    "INVALID_RESPONSE",
                    "Zoho token exchange: no refresh token",
                  ),
          ),
        ),
      ),
    refreshAccessToken: ({ accountsServer, refreshToken }) =>
      tokenCall("token refresh", accountsServer, "/oauth/v2/token", {
        grant_type: "refresh_token",
        client_id: settings.clientId,
        client_secret: Redacted.value(settings.clientSecret),
        refresh_token: Redacted.value(refreshToken),
      }).pipe(
        Effect.flatMap((reply) => accessTokenFrom("token refresh", reply)),
      ),
    revokeToken: ({ accountsServer, token }) =>
      tokenCall("token revoke", accountsServer, "/oauth/v2/token/revoke", {
        token: Redacted.value(token),
      }).pipe(Effect.asVoid),
    listOrganizations: (session) =>
      books(
        "organizations",
        session,
        "/organizations",
        {},
        organizationsReplySchema,
      ).pipe(
        Effect.map(({ organizations }) =>
          organizations.map((organization) => ({
            id: organization.organization_id,
            name: organization.name,
            currencyCode: organization.currency_code,
          })),
        ),
      ),
    listAccounts: (session, organizationId) =>
      Effect.gen(function* () {
        const accounts: ZohoBooksAccount[] = [];
        for (let page = 1; page <= MAX_ACCOUNT_PAGES; page += 1) {
          const reply = yield* books(
            "chart of accounts",
            session,
            "/chartofaccounts",
            {
              organization_id: organizationId,
              filter_by: "AccountType.Active",
              page: String(page),
              per_page: String(ACCOUNTS_PAGE_SIZE),
            },
            accountsReplySchema,
          );
          for (const account of reply.chartofaccounts) {
            if (account.is_active === false) continue;
            accounts.push({
              id: account.account_id,
              name: account.account_name,
              code:
                account.account_code === ""
                  ? null
                  : (account.account_code ?? null),
              type: account.account_type,
            });
          }
          if (!reply.page_context?.has_more_page) return accounts;
        }
        return yield* fail(
          "INVALID_RESPONSE",
          "Zoho chart of accounts: more pages than expected",
        );
      }),
    findExpenses: (session, organizationId, referenceNumber) =>
      books(
        "expense search",
        session,
        "/expenses",
        {
          organization_id: organizationId,
          reference_number: referenceNumber,
          per_page: String(EXPENSE_SEARCH_PAGE_SIZE),
        },
        expensesReplySchema,
      ).pipe(
        Effect.flatMap((reply) =>
          // A reference is one item's, so a second page means something's off.
          reply.page_context?.has_more_page
            ? fail(
                "INVALID_RESPONSE",
                "Zoho expense search: more matches than expected",
              )
            : Effect.succeed(
                reply.expenses
                  .map(toExpense)
                  .filter((found) => found.referenceNumber === referenceNumber),
              ),
        ),
      ),
    createExpense: (session, organizationId, draft) => {
      const body = expenseBody(draft);
      if (body === null) {
        return fail("API_ERROR", "Zoho create expense: malformed amount");
      }
      return books(
        "create expense",
        session,
        "/expenses",
        { organization_id: organizationId },
        createdExpenseReplySchema,
        { method: "POST", body },
      ).pipe(Effect.map(({ expense }) => toExpense(expense)));
    },
    attachReceipt: (session, organizationId, expenseId, file) => {
      const form = new FormData();
      form.set(
        "receipt",
        new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
        file.fileName,
      );
      return books(
        "attach receipt",
        session,
        `/expenses/${encodeURIComponent(expenseId)}/receipt`,
        { organization_id: organizationId },
        booksReplySchema,
        { method: "POST", body: form },
      ).pipe(Effect.asVoid);
    },
  };
}

const notConfigured = (): Effect.Effect<never, ZohoError> =>
  fail(
    "NOT_CONFIGURED",
    "Zoho isn't configured: set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REDIRECT_URI",
  );

const unconfigured: ZohoShape = {
  configured: false,
  authorizeUrl: notConfigured,
  connectLinkUrl: notConfigured,
  exchangeCode: notConfigured,
  refreshAccessToken: notConfigured,
  revokeToken: notConfigured,
  listOrganizations: notConfigured,
  listAccounts: notConfigured,
  findExpenses: notConfigured,
  createExpense: notConfigured,
  attachReceipt: notConfigured,
};

/**
 * Optional, like Resend and Telnyx: without all three settings the API still
 * starts and the Zoho endpoints answer that Zoho isn't set up.
 */
export const ZohoLive: Layer.Layer<Zoho, ConfigError.ConfigError> =
  Layer.effect(
    Zoho,
    Effect.gen(function* () {
      const settings = yield* Config.option(
        Config.all({
          clientId: Config.string("ZOHO_CLIENT_ID"),
          clientSecret: Config.redacted("ZOHO_CLIENT_SECRET"),
          redirectUri: Config.url("ZOHO_REDIRECT_URI").pipe(
            Config.map((url) => url.href),
          ),
        }),
      );
      if (Option.isNone(settings)) {
        console.warn(
          "[zoho] ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REDIRECT_URI aren't all set; Zoho Books can't be connected",
        );
        return unconfigured;
      }
      return makeZohoClient(settings.value);
    }),
  );
