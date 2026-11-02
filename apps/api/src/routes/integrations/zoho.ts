import type { Context } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Cause, Effect, Exit, Option } from "effect";
import { Hono } from "hono";

import type { AppDeps } from "../../layers/main.js";
import type { AppRuntime } from "../../runtime.js";
import { isClientError } from "../../errors.js";
import { RequestMeta, requestMetaFrom } from "../../http/request-meta.js";
import {
  completeZohoSignIn,
  startZohoSignIn,
} from "../../services/zoho/sign-in.js";

type PageContext = Context<{ Variables: RequestIdVariables }>;

/**
 * The connect link's URL carries its token, so nothing here may send it on:
 * no referrer, no caching, no framing, no outside resources.
 */
const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

function page(
  c: PageContext,
  status: ContentfulStatusCode,
  title: string,
  message: string,
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Expendi Business</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafaf9;color:#1c1917;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:28rem;margin:1.5rem;padding:2rem;background:#fff;border:1px solid #e7e5e4;border-radius:.75rem}
h1{margin:0 0 .5rem;font-size:1.125rem}
p{margin:0;color:#57534e;line-height:1.5}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
  return c.html(html, status, PAGE_HEADERS);
}

async function run<A, E>(
  runtime: AppRuntime,
  c: PageContext,
  effect: Effect.Effect<A, E, AppDeps | RequestMeta>,
  onSuccess: (value: A) => Response,
): Promise<Response> {
  const exit = await runtime.runPromiseExit(
    Effect.provideService(effect, RequestMeta, requestMetaFrom(c)),
  );
  if (Exit.isSuccess(exit)) return onSuccess(exit.value);

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure) && isClientError(failure.value)) {
    return page(
      c,
      failure.value.status,
      "Zoho Books wasn't connected",
      failure.value.message,
    );
  }
  console.error(
    `[http] request ${c.get("requestId")} failed`,
    Cause.pretty(exit.cause),
  );
  return page(
    c,
    500,
    "Zoho Books wasn't connected",
    "Something went wrong on our side. Open your connect link again in a few minutes.",
  );
}

/**
 * Mounted at `/integrations/zoho`. Public: the accountant opening a connect
 * link has no Expendi login. The link's token and Zoho's signed state are
 * what authorize each step (spec §6.17).
 */
export function createZohoIntegrationRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: RequestIdVariables }> {
  return new Hono<{ Variables: RequestIdVariables }>()
    .get("/connect", (c) =>
      run(runtime, c, startZohoSignIn(c.req.query("token") ?? ""), (url) => {
        const response = c.redirect(url, 302);
        for (const [name, value] of Object.entries(PAGE_HEADERS)) {
          response.headers.set(name, value);
        }
        return response;
      }),
    )
    .get("/callback", (c) =>
      run(
        runtime,
        c,
        completeZohoSignIn({
          state: c.req.query("state"),
          code: c.req.query("code"),
          accountsServer: c.req.query("accounts-server"),
          error: c.req.query("error"),
        }),
        () =>
          page(
            c,
            200,
            "Zoho Books is connected",
            "Expendi can now read this company's Zoho organizations and chart of accounts and record its expenses. You can close this page.",
          ),
      ),
    );
}
