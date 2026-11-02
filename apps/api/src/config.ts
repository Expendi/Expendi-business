import type { ConfigError, Option, Redacted } from "effect";
import { Config, Context, Effect, Layer } from "effect";

export interface AppConfig {
  readonly port: number;
  /** Non-owner app role. Row-level security must apply to it. */
  readonly databaseUrl: Redacted.Redacted;
  /**
   * Where an invite email sends people to install the app (spec §6.2).
   * Optional: without it, invites are still created but not emailed.
   */
  readonly appInstallUrl: Option.Option<string>;
  /**
   * Origins of the internal admin app (spec §6.15), allowed to call
   * `/internal/*` from the browser. Empty: no cross-origin access.
   */
  readonly adminAppOrigins: readonly string[];
}

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  AppConfig
>() {}

export const ConfigLive: Layer.Layer<ConfigService, ConfigError.ConfigError> =
  Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const port = yield* Config.withDefault(Config.port("PORT"), 3000);
      const databaseUrl = yield* Config.redacted("DATABASE_URL");
      const appInstallUrl = yield* Config.option(
        Config.url("APP_INSTALL_URL").pipe(Config.map((url) => url.href)),
      );
      const adminAppOrigins = yield* Config.withDefault(
        Config.string("ADMIN_APP_ORIGINS"),
        "",
      ).pipe(
        Config.map((raw) =>
          raw
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
        ),
      );
      return { port, databaseUrl, appInstallUrl, adminAppOrigins };
    }),
  );
