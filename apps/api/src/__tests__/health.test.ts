import { afterAll, describe, expect, it } from "vitest";

import { healthResponseSchema } from "@expendi-business/shared";

import { createApp } from "../app.js";
import { makeTestRuntime } from "./helpers/runtime.js";

const runtime = makeTestRuntime();
const app = createApp({ runtime });

afterAll(async () => {
  await runtime.dispose();
});

describe("GET /health", () => {
  it("returns 200 with an ok status", async () => {
    // #when
    const response = await app.request("/health");

    // #then
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
    });
  });

  it("generates an x-request-id when the caller sends none", async () => {
    // #when
    const response = await app.request("/health");

    // #then
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a well-formed incoming x-request-id", async () => {
    // #given
    const incoming = "mobile-3f9a2c";

    // #when
    const response = await app.request("/health", {
      headers: { "x-request-id": incoming },
    });

    // #then
    expect(response.headers.get("x-request-id")).toBe(incoming);
  });

  it("replaces a malformed incoming x-request-id", async () => {
    // #given
    const incoming = "bad id; drop table";

    // #when
    const response = await app.request("/health", {
      headers: { "x-request-id": incoming },
    });

    // #then
    expect(response.headers.get("x-request-id")).not.toBe(incoming);
  });
});

describe("responses on error paths", () => {
  it("carry an x-request-id on 401s too", async () => {
    // #when
    const response = await app.request(`/organizations/${crypto.randomUUID()}`);

    // #then
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
