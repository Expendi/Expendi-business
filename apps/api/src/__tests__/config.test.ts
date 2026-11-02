import type { ConfigError } from "effect";
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { ConfigLive, ConfigService } from "../config.js";

const DATABASE_URL = "postgres://app@localhost:5432/db";

function loadConfig(
  env: Record<string, string>,
): Effect.Effect<AppConfig, ConfigError.ConfigError> {
  const provider = ConfigProvider.fromMap(new Map(Object.entries(env)));
  return ConfigService.pipe(
    Effect.provide(
      ConfigLive.pipe(Layer.provide(Layer.setConfigProvider(provider))),
    ),
  );
}

describe("ConfigLive", () => {
  it("defaults PORT to 3000 when unset", async () => {
    // #given
    const env = { DATABASE_URL };

    // #when
    const config = await Effect.runPromise(loadConfig(env));

    // #then
    expect(config.port).toBe(3000);
  });

  it("reads PORT and a redacted DATABASE_URL from the environment", async () => {
    // #given
    const env = { PORT: "8080", DATABASE_URL };

    // #when
    const config = await Effect.runPromise(loadConfig(env));

    // #then
    expect(config.port).toBe(8080);
    expect(Redacted.value(config.databaseUrl)).toBe(DATABASE_URL);
    expect(JSON.stringify(config)).not.toContain(DATABASE_URL);
  });

  it("fails to load without DATABASE_URL", async () => {
    // #when
    const exit = await Effect.runPromiseExit(loadConfig({}));

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("reads APP_INSTALL_URL when it is set", async () => {
    // #given
    const env = {
      DATABASE_URL,
      APP_INSTALL_URL: "https://business.expendi.app/install",
    };

    // #when
    const config = await Effect.runPromise(loadConfig(env));

    // #then
    expect(config.appInstallUrl).toEqual(
      Option.some("https://business.expendi.app/install"),
    );
  });

  it("loads without APP_INSTALL_URL, so invites are created but not emailed", async () => {
    // #when
    const config = await Effect.runPromise(loadConfig({ DATABASE_URL }));

    // #then
    expect(Option.isNone(config.appInstallUrl)).toBe(true);
  });

  it("fails to load when APP_INSTALL_URL isn't a URL", async () => {
    // #given
    const env = { DATABASE_URL, APP_INSTALL_URL: "not a url" };

    // #when
    const exit = await Effect.runPromiseExit(loadConfig(env));

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("reads ADMIN_APP_ORIGINS as a comma-separated list", async () => {
    // #given
    const env = {
      DATABASE_URL,
      ADMIN_APP_ORIGINS: " https://ops.expendi.app, ,http://localhost:3001 ",
    };

    // #when
    const config = await Effect.runPromise(loadConfig(env));

    // #then
    expect(config.adminAppOrigins).toEqual([
      "https://ops.expendi.app",
      "http://localhost:3001",
    ]);
  });

  it("allows no admin app origins without ADMIN_APP_ORIGINS", async () => {
    // #when
    const config = await Effect.runPromise(loadConfig({ DATABASE_URL }));

    // #then
    expect(config.adminAppOrigins).toEqual([]);
  });

  it.each(["not-a-number", "0", "70000", ""])(
    "fails to load when PORT is invalid (%j)",
    async (port) => {
      // #given
      const env = { PORT: port, DATABASE_URL };

      // #when
      const exit = await Effect.runPromiseExit(loadConfig(env));

      // #then
      expect(Exit.isFailure(exit)).toBe(true);
    },
  );
});
