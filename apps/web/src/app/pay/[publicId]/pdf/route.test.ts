import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const PUBLIC_ID = "TRa-kYDu4L9O1QLCvqcm38Y2Q1ev19Cfgq1YGCWDXfk";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);

const fetchMock = vi.fn<typeof fetch>();

const get = (publicId = PUBLIC_ID) =>
  GET(new Request(`https://business.expendi.test/pay/${publicId}/pdf`), {
    params: Promise.resolve({ publicId }),
  });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.expendi.test/");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /pay/:publicId/pdf", () => {
  it("passes the API's PDF through with its type and file name", async () => {
    // #given
    fetchMock.mockResolvedValue(
      new Response(PDF_BYTES, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="INV-0013.pdf"',
        },
      }),
    );

    // #when
    const response = await get();

    // #then
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.expendi.test/pay/${PUBLIC_ID}/pdf`,
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
    );
    expect({
      status: response.status,
      type: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      cache: response.headers.get("cache-control"),
      bytes: [...new Uint8Array(await response.arrayBuffer())],
    }).toEqual({
      status: 200,
      type: "application/pdf",
      disposition: 'attachment; filename="INV-0013.pdf"',
      cache: "no-store",
      bytes: [...PDF_BYTES],
    });
  });

  it("answers a plain 404 when the API doesn't know the invoice, without its body", async () => {
    // #given
    fetchMock.mockResolvedValue(
      Response.json(
        { success: false, error: { _tag: "NotFound", message: "internal" } },
        { status: 404 },
      ),
    );

    // #when
    const response = await get();

    // #then
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("This invoice link isn't valid.");
  });

  it.each([500, 503, 429, 400])(
    "answers a plain 502 when the API answers %i",
    async (status) => {
      // #given
      fetchMock.mockResolvedValue(
        new Response("stack trace: db password", { status }),
      );

      // #when
      const response = await get();

      // #then
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(
        "Couldn't get the PDF. Try again in a minute.",
      );
    },
  );

  it("answers 502 when the API can't be reached", async () => {
    // #given
    fetchMock.mockRejectedValue(new TypeError("connect ECONNREFUSED 10.0.0.5"));

    // #when
    const response = await get();

    // #then
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("ECONNREFUSED");
  });

  it("answers 502 when the API's address isn't configured", async () => {
    // #given
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");

    // #when
    const response = await get();

    // #then
    expect(response.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 without asking the API for something that isn't a public ID", async () => {
    // #when
    const response = await get("../../admin");

    // #then
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
