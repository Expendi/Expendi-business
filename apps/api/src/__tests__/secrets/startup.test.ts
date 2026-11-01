import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  start: vi.fn<(port?: string) => void>(),
}));

vi.mock("dotenv/config", () => ({}));
vi.mock("../../server.js", () => {
  // Emulate a dependency that reads env at module evaluation time.
  observed.start(process.env.PORT);
  return {};
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("SECRETS_MANAGER", "doppler");
  vi.stubEnv("DOPPLER_TOKEN", "test-token");
  vi.stubEnv("PORT", "3000");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("API startup", () => {
  it("does not load the server until remote secrets are applied", async () => {
    // #given
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // #when
    const startup = import("../../index.js");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    // #then
    expect(observed.start).not.toHaveBeenCalled();
    finish?.(new Response(JSON.stringify({ PORT: "4000" })));
    await startup;
    expect(observed.start).toHaveBeenCalledWith("4000");
  });

  it("never starts the server after a secrets failure", async () => {
    // #given
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private", { status: 401 })),
    );

    // #when
    const startup = import("../../index.js");

    // #then
    await expect(startup).rejects.toThrow(
      "Doppler secret download failed (HTTP 401)",
    );
    expect(observed.start).not.toHaveBeenCalled();
  });
});
