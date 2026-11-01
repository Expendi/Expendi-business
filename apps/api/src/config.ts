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
      return { port, databaseUrl, appInstallUrl };
    }),
  );
