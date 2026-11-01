import type { ConfigError } from "effect";
import { Layer } from "effect";

import type { ConfigService } from "../config.js";
import type { DatabaseService } from "../db/client.js";
import type { DatabaseError } from "../errors.js";
import type { AuditLog } from "../services/audit/audit-log.js";
import type { PrivyAuth } from "../services/auth/privy-auth.js";
import { ConfigLive } from "../config.js";
import { DatabaseLive } from "../db/client.js";
import { AuditLogLive } from "../services/audit/audit-log.js";
import { PrivyAuthLive } from "../services/auth/privy-auth.js";

export type AppDeps = ConfigService | DatabaseService | AuditLog | PrivyAuth;
export type AppLayerError = ConfigError.ConfigError | DatabaseError;

/** Tests swap in a fake Privy; everything else is the production stack. */
export function makeAppLayer(
  privyAuth: Layer.Layer<PrivyAuth, AppLayerError>,
): Layer.Layer<AppDeps, AppLayerError> {
  return Layer.mergeAll(DatabaseLive, AuditLogLive, privyAuth).pipe(
    Layer.provideMerge(ConfigLive),
  );
}

export const MainLayer: Layer.Layer<AppDeps, AppLayerError> =
  makeAppLayer(PrivyAuthLive);
