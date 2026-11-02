import type { Redacted } from "effect";
import { Context, Layer } from "effect";

/**
 * Zoho access tokens last an hour and Zoho allows only 10 per refresh token
 * every 10 minutes, so each connection's token is kept in memory until a
 * minute before it expires. An entry belongs to one sealed refresh token: a
 * new sign-in on the connection stores a new one, which misses the cache.
 */
export interface CachedAccessToken {
  readonly sealedRefreshToken: string;
  readonly accessToken: Redacted.Redacted;
  readonly apiDomain: string;
  readonly expiresAt: number;
}

const EXPIRY_MARGIN_MS = 60_000;

export interface ZohoAccessTokensShape {
  readonly get: (
    connectionId: string,
    sealedRefreshToken: string,
  ) => CachedAccessToken | null;
  readonly put: (
    connectionId: string,
    token: Omit<CachedAccessToken, "expiresAt"> & {
      readonly expiresInSeconds: number;
    },
  ) => void;
  readonly evict: (connectionId: string) => void;
}

export class ZohoAccessTokens extends Context.Tag("ZohoAccessTokens")<
  ZohoAccessTokens,
  ZohoAccessTokensShape
>() {}

export function makeZohoAccessTokens(
  now: () => number = Date.now,
): ZohoAccessTokensShape {
  const tokens = new Map<string, CachedAccessToken>();
  return {
    get: (connectionId, sealedRefreshToken) => {
      const cached = tokens.get(connectionId);
      const usable =
        cached?.sealedRefreshToken === sealedRefreshToken &&
        cached.expiresAt - EXPIRY_MARGIN_MS > now();
      return usable ? cached : null;
    },
    put: (connectionId, { expiresInSeconds, ...token }) => {
      tokens.set(connectionId, {
        ...token,
        expiresAt: now() + expiresInSeconds * 1000,
      });
    },
    evict: (connectionId) => {
      tokens.delete(connectionId);
    },
  };
}

export const ZohoAccessTokensLive: Layer.Layer<ZohoAccessTokens> = Layer.sync(
  ZohoAccessTokens,
  () => makeZohoAccessTokens(),
);
