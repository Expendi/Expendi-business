import type { Context as HonoContext } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import { Context } from "effect";

/** Where a request came from; attached to audit entries written during it. */
export interface RequestMetaShape {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export class RequestMeta extends Context.Tag("RequestMeta")<
  RequestMeta,
  RequestMetaShape
>() {}

/**
 * The API sits behind one trusted proxy (Railway's edge), which appends the
 * address it saw to X-Forwarded-For. Earlier entries are client-supplied and
 * can be forged, so only the last one is used.
 */
function clientIp(c: HonoContext): string | null {
  const forwardedFor = c.req.header("x-forwarded-for");
  const lastHop = forwardedFor
    ?.split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0)
    .at(-1);
  return lastHop ?? null;
}

export function requestMetaFrom<V extends RequestIdVariables>(
  c: HonoContext<{ Variables: V }>,
): RequestMetaShape {
  return {
    requestId: c.get("requestId"),
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  };
}
