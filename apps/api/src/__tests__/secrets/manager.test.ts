import type { Mock } from "vitest";
import { Config, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeSecrets } from "../../secrets/index.js";
import { applySecrets } from "../../secrets/manager.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function firstRequest(fetchMock: Mock<typeof fetch>): {
  url: URL;
  headers: Headers;
  init: RequestInit | undefined;
} {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("fetch was not called");
  const [input, init] = call;
  if (typeof input !== "string") throw new Error("expected a string URL");
  return { url: new URL(input), headers: new Headers(init?.headers), init };
}

describe("applySecrets", () => {
  it("overrides clashes (including empty strings) and preserves env-only settings", async () => {
    // #given
    const env = { SHARED: "old", LOCAL: "kept", DISABLED: "old" };

    // #when
    await applySecrets(
      {
        load: () =>
          Promise.resolve({ SHARED: "new", DISABLED: "", REMOTE: "added" }),
      },
      env,
    );

    // #then
    expect(env).toEqual({
      SHARED: "new",
      LOCAL: "kept",
      DISABLED: "",
      REMOTE: "added",
    });
  });

  it("makes overrides visible to Effect Config", async () => {
    // #given
    vi.stubEnv("SECRETS_TEST_VALUE", "old");

    // #when
    await applySecrets({
      load: () => Promise.resolve({ SECRETS_TEST_VALUE: "remote" }),
    });

    // #then
    expect(await Effect.runPromise(Config.string("SECRETS_TEST_VALUE"))).toBe(
      "remote",
    );
  });

  it.each<unknown>([
    null,
    [],
    "secret-body",
    { GOOD: "new", BAD: null },
    { GOOD: "new", BAD: 123 },
    { GOOD: "new", "BAD=KEY": "secret" },
    { GOOD: "new", BAD: "nul\u0000secret" },
  ])(
    "rejects malformed payload %# atomically without exposing values",
    async (payload) => {
      // #given
      const env = { GOOD: "old" };

      // #when
      const result = applySecrets(
        { load: () => Promise.resolve(payload) },
        env,
      );

      // #then
      await expect(result).rejects.toThrow(
        /^Secrets manager returned an invalid secret (map|entry)$/,
      );
      expect(env).toEqual({ GOOD: "old" });
    },
  );

  it("sanitizes provider errors and leaves local values untouched", async () => {
    // #given
    const env = { KEY: "old" };
    const failing = {
      load: () => Promise.reject(new Error("sensitive-token")),
    };

    // #when
    const result = applySecrets(failing, env);

    // #then
    await expect(result).rejects.toThrow(
      "Secrets manager could not load secrets",
    );
    expect(env).toEqual({ KEY: "old" });
  });
});

describe("initializeSecrets", () => {
  it.each([undefined, "env"])(
    "stays network-free in env mode (%s)",
    async (provider) => {
      // #given
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      const env = {
        SECRETS_MANAGER: provider,
        KEY: "old",
        DOPPLER_TOKEN: "unused",
      };

      // #when
      await initializeSecrets(env);

      // #then
      expect(env.KEY).toBe("old");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown provider", async () => {
    // #given
    const env = { SECRETS_MANAGER: "typo" };

    // #when
    const result = initializeSecrets(env);

    // #then
    await expect(result).rejects.toThrow("Unsupported SECRETS_MANAGER");
  });

  it("requires DOPPLER_TOKEN in doppler mode", async () => {
    // #given
    const env = { SECRETS_MANAGER: "doppler" };

    // #when
    const result = initializeSecrets(env);

    // #then
    await expect(result).rejects.toThrow("DOPPLER_TOKEN is required");
  });
});

describe("Doppler adapter", () => {
  const bootstrap = { SECRETS_MANAGER: "doppler", DOPPLER_TOKEN: "test-token" };

  it("downloads the secret map with service-token scope and overlays env", async () => {
    // #given
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ KEY: "remote", EMPTY: "" })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const env = { ...bootstrap, KEY: "old", LOCAL: "kept", EMPTY: "old" };

    // #when
    await initializeSecrets(env);

    // #then
    expect(env).toMatchObject({ KEY: "remote", LOCAL: "kept", EMPTY: "" });
    const { url, headers, init } = firstRequest(fetchMock);
    expect(url.origin).toBe("https://api.doppler.com");
    expect(url.pathname).toBe("/v3/configs/config/secrets/download");
    expect([...url.searchParams.entries()]).toEqual([["format", "json"]]);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("passes explicit project and config selectors through", async () => {
    // #given
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    // #when
    await initializeSecrets({
      ...bootstrap,
      DOPPLER_PROJECT: "expendi-business",
      DOPPLER_CONFIG: "prd",
    });

    // #then
    const { url } = firstRequest(fetchMock);
    expect(url.searchParams.get("project")).toBe("expendi-business");
    expect(url.searchParams.get("config")).toBe("prd");
  });

  it.each([401, 403, 429, 500])(
    "fails closed on HTTP %s without leaking the response body",
    async (status) => {
      // #given
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("sensitive-response", { status })),
      );
      const env = { ...bootstrap, KEY: "old" };

      // #when
      const result = initializeSecrets(env);

      // #then
      await expect(result).rejects.toThrow(
        `Doppler secret download failed (HTTP ${status})`,
      );
      expect(env.KEY).toBe("old");
    },
  );

  it("sanitizes malformed JSON", async () => {
    // #given
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("secret-invalid-json")),
    );

    // #when
    const result = initializeSecrets(bootstrap);

    // #then
    await expect(result).rejects.toThrow(
      "Doppler secret download failed or timed out",
    );
  });

  it("sanitizes transport failures including timeouts", async () => {
    // #given
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("private-request-headers")),
    );

    // #when
    const result = initializeSecrets(bootstrap);

    // #then
    await expect(result).rejects.toThrow(
      "Doppler secret download failed or timed out",
    );
  });
});
