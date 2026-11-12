import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQuote, fetchInvoice, fetchQuote } from "./pay-api";

const QUOTE = {
  id: "7f0c6f3e-5c1b-4a52-9d57-0a0e6f6f3a11",
  chain: "base",
  amountIn: "1250000000",
  depositAddress: "0xabc",
  deadline: "2026-11-12T12:00:00.000Z",
  status: "awaiting_deposit",
};

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("the public pay API client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.test/");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("calls the API root with no credentials and parses a quote", async () => {
    fetchMock.mockResolvedValue(respond(200, QUOTE));

    const result = await fetchQuote("pub/id", QUOTE.id);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect({
      url,
      credentials: init?.credentials,
      hasAuth: new Headers(init?.headers).has("Authorization"),
      result,
    }).toEqual({
      url: `https://api.test/pay/pub%2Fid/quotes/${QUOTE.id}`,
      credentials: "omit",
      hasAuth: false,
      result: { ok: true, data: QUOTE },
    });
  });

  it("posts the chosen chain as JSON", async () => {
    fetchMock.mockResolvedValue(respond(201, QUOTE));

    await createQuote("abc", "solana");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect({ url, method: init?.method, body: init?.body }).toEqual({
      url: "https://api.test/pay/abc/quotes",
      method: "POST",
      body: JSON.stringify({ chain: "solana" }),
    });
  });

  it("returns the API's message for a refused quote", async () => {
    fetchMock.mockResolvedValue(
      respond(503, { message: "Payments are unavailable right now." }),
    );

    expect(await createQuote("abc", "base")).toEqual({
      ok: false,
      status: 503,
      message: "Payments are unavailable right now.",
    });
  });

  it("reports a 404 for an unknown link", async () => {
    fetchMock.mockResolvedValue(respond(404, { message: "Not found" }));

    expect(await fetchInvoice("nope")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("treats a network failure as having no status", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await fetchInvoice("abc")).toMatchObject({
      ok: false,
      status: null,
    });
  });

  it("rejects a response that doesn't match the contract", async () => {
    fetchMock.mockResolvedValue(respond(200, { number: "INV-1" }));

    expect(await fetchInvoice("abc")).toMatchObject({ ok: false });
  });
});
