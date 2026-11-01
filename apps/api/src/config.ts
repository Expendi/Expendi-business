import type { ConfigError, Redacted } from "effect";
import { Config, Context, Effect, Layer } from "effect";

export interface AppConfig {
  readonly port: number;
  /** Non-owner app role. Row-level security must apply to it. */
  readonly databaseUrl: Redacted.Redacted;
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
      return { port, databaseUrl };
    }),
  );
