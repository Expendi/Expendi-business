import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import type { ZohoError } from "../../services/zoho/zoho-client.js";
import {
  makeZohoClient,
  ZOHO_SCOPES,
  zohoAccountsServer,
  zohoApiDomain,
} from "../../services/zoho/zoho-client.js";

const CLIENT_SECRET = "zoho-client-secret-value";
const REFRESH_TOKEN = "1000.refresh-token-value";
const ACCESS_TOKEN = "1000.access-token-value";
const REDIRECT_URI = "https://api.expendi.test/integrations/zoho/callback";

interface Sent {
  readonly url: URL;
  readonly init: RequestInit | undefined;
}

function client(...replies: (() => Response)[]) {
  const sent: Sent[] = [];
  const zoho = makeZohoClient(
    {
      clientId: "1000.CLIENTID",
      clientSecret: Redacted.make(CLIENT_SECRET),
      redirectUri: REDIRECT_URI,
    },
    (input, init) => {
      const url = input instanceof Request ? input.url : new URL(input).href;
      sent.push({ url: new URL(url), init });
      const reply = replies.shift();
      return reply
        ? Promise.resolve(reply())
        : Promise.reject(new Error("no reply queued"));
    },
  );
  return { zoho, sent };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

async function failureOf<A>(
  effect: Effect.Effect<A, ZohoError>,
): Promise<ZohoError | null> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))
    : null;
}

const session = {
  apiDomain: "https://www.zohoapis.eu",
  accessToken: Redacted.make(ACCESS_TOKEN),
};

describe("zohoAccountsServer / zohoApiDomain", () => {
  it.each([
    "https://accounts.zoho.com",
    "https://accounts.zoho.eu",
    "https://accounts.zoho.in",
    "https://accounts.zoho.com.au",
    "https://accounts.zohocloud.ca",
  ])("accepts Zoho's accounts server %s", (server) => {
    // #then
    expect(zohoAccountsServer(server)).toBe(server);
  });

  it.each([
    "https://accounts.zoho.com.evil.test",
    "http://accounts.zoho.com",
    "https://evil.test",
    "https://accounts.zoho.com:8443",
    "https://user@accounts.zoho.com",
    "https://accounts.zoho.com/oauth",
    "not a url",
  ])("refuses %s as an accounts server", (server) => {
    // #then
    expect(zohoAccountsServer(server)).toBeNull();
  });

  it("accepts Books API domains and nothing else", () => {
    // #then
    expect(zohoApiDomain("https://www.zohoapis.com")).toBe(
      "https://www.zohoapis.com",
    );
    expect(zohoApiDomain("https://www.zohoapis.com.au")).toBe(
      "https://www.zohoapis.com.au",
    );
    expect(zohoApiDomain("https://www.zohoapis.com.evil.test")).toBeNull();
    expect(zohoApiDomain("https://api.zoho.com")).toBeNull();
  });
});

describe("makeZohoClient", () => {
  it("asks for offline access with consent and only the scopes §6.17 needs", async () => {
    // #given
    const { zoho } = client();

    // #when
    const url = new URL(await Effect.runPromise(zoho.authorizeUrl("signed")));

    // #then
    expect(url.origin + url.pathname).toBe(
      "https://accounts.zoho.com/oauth/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope:
        "ZohoBooks.settings.READ,ZohoBooks.accountants.READ,ZohoBooks.expenses.CREATE,ZohoBooks.expenses.READ",
      client_id: "1000.CLIENTID",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      redirect_uri: REDIRECT_URI,
      state: "signed",
    });
    expect(ZOHO_SCOPES).toHaveLength(4);
  });

  it("builds the connect link beside the callback", async () => {
    // #given
    const { zoho } = client();

    // #then
    expect(await Effect.runPromise(zoho.connectLinkUrl("tok"))).toBe(
      "https://api.expendi.test/integrations/zoho/connect?token=tok",
    );
  });

  it("exchanges the code at the accounts server Zoho named", async () => {
    // #given
    const { zoho, sent } = client(
      json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        api_domain: "https://www.zohoapis.eu",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );

    // #when
    const grant = await Effect.runPromise(
      zoho.exchangeCode({
        accountsServer: "https://accounts.zoho.eu",
        code: "1000.code",
      }),
    );

    // #then
    expect(Redacted.value(grant.refreshToken)).toBe(REFRESH_TOKEN);
    expect(grant.apiDomain).toBe("https://www.zohoapis.eu");
    const [request] = sent;
    expect(request?.init?.method).toBe("POST");
    expect(request?.url.origin + (request?.url.pathname ?? "")).toBe(
      "https://accounts.zoho.eu/oauth/v2/token",
    );
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      grant_type: "authorization_code",
      client_id: "1000.CLIENTID",
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: "1000.code",
    });
    expect(JSON.stringify(grant)).not.toContain(REFRESH_TOKEN);
  });

  it("never sends the client secret to a server that isn't Zoho's", async () => {
    // #given
    const { zoho, sent } = client();

    // #when
    const error = await failureOf(
      zoho.exchangeCode({
        accountsServer: "https://accounts.zoho.com.evil.test",
        code: "1000.code",
      }),
    );

    // #then
    expect(error?.code).toBe("API_ERROR");
    expect(sent).toEqual([]);
  });

  it("refuses a token reply whose API domain isn't Zoho's", async () => {
    // #given
    const { zoho } = client(
      json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        api_domain: "https://evil.test",
        expires_in: 3600,
      }),
    );

    // #when
    const error = await failureOf(
      zoho.exchangeCode({
        accountsServer: "https://accounts.zoho.com",
        code: "1000.code",
      }),
    );

    // #then
    expect(error?.code).toBe("INVALID_RESPONSE");
  });

  it.each([
    ["Zoho's invalid_code", json({ error: "invalid_code" })],
    ["invalid_grant", json({ error: "invalid_grant" }, 400)],
    ["HTTP 401", json({}, 401)],
  ])("treats %s on refresh as a dead refresh token", async (_label, reply) => {
    // #given
    const { zoho } = client(reply);

    // #when
    const error = await failureOf(
      zoho.refreshAccessToken({
        accountsServer: "https://accounts.zoho.com",
        refreshToken: Redacted.make(REFRESH_TOKEN),
      }),
    );

    // #then
    expect(error?.code).toBe("INVALID_GRANT");
    expect(error?.message).not.toContain(REFRESH_TOKEN);
    expect(error?.message).not.toContain(CLIENT_SECRET);
  });

  it("keeps a wrong client secret apart from a dead token", async () => {
    // #given
    const { zoho } = client(json({ error: "invalid_client" }));

    // #when
    const error = await failureOf(
      zoho.refreshAccessToken({
        accountsServer: "https://accounts.zoho.com",
        refreshToken: Redacted.make(REFRESH_TOKEN),
      }),
    );

    // #then
    expect(error?.code).toBe("API_ERROR");
  });

  it("reports an unreachable Zoho without the request's details", async () => {
    // #given
    const { zoho } = client(() => {
      throw new Error(`connect failed ${REFRESH_TOKEN}`);
    });

    // #when
    const error = await failureOf(
      zoho.refreshAccessToken({
        accountsServer: "https://accounts.zoho.com",
        refreshToken: Redacted.make(REFRESH_TOKEN),
      }),
    );

    // #then
    expect(error?.code).toBe("NETWORK_ERROR");
    expect(error?.message).not.toContain(REFRESH_TOKEN);
  });

  it("revokes at the stored accounts server", async () => {
    // #given
    const { zoho, sent } = client(json({ status: "success" }));

    // #when
    await Effect.runPromise(
      zoho.revokeToken({
        accountsServer: "https://accounts.zoho.in",
        token: Redacted.make(REFRESH_TOKEN),
      }),
    );

    // #then
    expect(sent[0]?.url.origin + (sent[0]?.url.pathname ?? "")).toBe(
      "https://accounts.zoho.in/oauth/v2/token/revoke",
    );
  });

  it("lists organizations from the stored API domain with Zoho's auth header", async () => {
    // #given
    const { zoho, sent } = client(
      json({
        code: 0,
        message: "success",
        organizations: [
          { organization_id: "10234695", name: "Acme", currency_code: "KES" },
          { organization_id: 20, name: "Other", currency_code: "USD" },
        ],
      }),
    );

    // #when
    const organizations = await Effect.runPromise(
      zoho.listOrganizations(session),
    );

    // #then
    expect(organizations).toEqual([
      { id: "10234695", name: "Acme", currencyCode: "KES" },
      { id: "20", name: "Other", currencyCode: "USD" },
    ]);
    expect(sent[0]?.url.href).toBe(
      "https://www.zohoapis.eu/books/v3/organizations",
    );
    expect(new Headers(sent[0]?.init?.headers).get("authorization")).toBe(
      `Zoho-oauthtoken ${ACCESS_TOKEN}`,
    );
  });

  it("pages through the active chart of accounts", async () => {
    // #given
    const { zoho, sent } = client(
      json({
        code: 0,
        chartofaccounts: [
          {
            account_id: "1",
            account_name: "Travel",
            account_code: "",
            account_type: "expense",
            is_active: true,
          },
        ],
        page_context: { page: 1, has_more_page: true },
      }),
      json({
        code: 0,
        chartofaccounts: [
          {
            account_id: "2",
            account_name: "Old",
            account_type: "expense",
            is_active: false,
          },
          {
            account_id: "3",
            account_name: "Bank",
            account_code: "1000",
            account_type: "bank",
          },
        ],
        page_context: { page: 2, has_more_page: false },
      }),
    );

    // #when
    const accounts = await Effect.runPromise(
      zoho.listAccounts(session, "10234695"),
    );

    // #then
    expect(accounts).toEqual([
      { id: "1", name: "Travel", code: null, type: "expense" },
      { id: "3", name: "Bank", code: "1000", type: "bank" },
    ]);
    expect(sent.map(({ url }) => url.searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
    expect(sent[0]?.url.searchParams.get("organization_id")).toBe("10234695");
    expect(sent[0]?.url.searchParams.get("filter_by")).toBe(
      "AccountType.Active",
    );
  });

  it("reports Books' 401 as UNAUTHORIZED", async () => {
    // #given
    const { zoho } = client(
      json({ code: 57, message: "You are not authorized" }, 401),
    );

    // #when
    const error = await failureOf(zoho.listOrganizations(session));

    // #then
    expect(error?.code).toBe("UNAUTHORIZED");
    expect(error?.message).not.toContain(ACCESS_TOKEN);
  });

  it("refuses to call an API domain that isn't Zoho's", async () => {
    // #given
    const { zoho, sent } = client();

    // #when
    const error = await failureOf(
      zoho.listOrganizations({ ...session, apiDomain: "https://evil.test" }),
    );

    // #then
    expect(error?.code).toBe("API_ERROR");
    expect(sent).toEqual([]);
  });
});
