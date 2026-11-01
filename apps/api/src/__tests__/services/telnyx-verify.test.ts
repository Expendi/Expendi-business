import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OtpProviderError } from "../../services/phone-verification/otp-provider.js";
import { OtpProvider } from "../../services/phone-verification/otp-provider.js";
import {
  makeTelnyxVerify,
  OtpProviderLive,
} from "../../services/phone-verification/telnyx-verify.js";

const API_KEY = "KEY_test_telnyx_secret";
const PROFILE_ID = "verify-profile-test";
const PHONE = "+254712345678";

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function telnyx(respond: () => Promise<Response>) {
  const sent: Sent[] = [];
  const provider = makeTelnyxVerify(
    { apiKey: Redacted.make(API_KEY), verifyProfileId: PROFILE_ID },
    (input, init) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        init,
      });
      return respond();
    },
  );
  return { provider, sent };
}

const reply = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

async function failureOf<A>(
  effect: Effect.Effect<A, OtpProviderError>,
): Promise<OtpProviderError | null> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))
    : null;
}

const bodyOf = (request: Sent | undefined): unknown =>
  typeof request?.init?.body === "string"
    ? JSON.parse(request.init.body)
    : null;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeTelnyxVerify: sending", () => {
  it("asks Telnyx to text the number a code with our Verify profile", async () => {
    // #given
    const { provider, sent } = telnyx(
      reply(200, { data: { id: "ver_123", status: "pending" } }),
    );

    // #when
    const result = await Effect.runPromise(
      provider.startVerification({ to: PHONE }),
    );

    // #then
    expect(result).toEqual({ providerRef: "ver_123" });
    const [request] = sent;
    expect(request?.url).toBe("https://api.telnyx.com/v2/verifications/sms");
    expect(request?.init?.method).toBe("POST");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(bodyOf(request)).toEqual({
      phone_number: PHONE,
      verify_profile_id: PROFILE_ID,
    });
  });

  it.each([
    [422, "MAX_SEND_ATTEMPTS"],
    [429, "RATE_LIMITED"],
    [401, "NOT_CONFIGURED"],
    [403, "NOT_CONFIGURED"],
    [500, "API_ERROR"],
  ])("maps HTTP %i to %s", async (status, code) => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider } = telnyx(
      reply(status, { errors: [{ code: "10015", detail: `bad ${PHONE}` }] }),
    );

    // #when
    const error = await failureOf(provider.startVerification({ to: PHONE }));

    // #then
    expect(error?.code).toBe(code);
  });

  it("keeps the number and Telnyx's text out of the error and the log", async () => {
    // #given
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider } = telnyx(
      reply(400, { errors: [{ code: "10015", detail: `bad ${PHONE}` }] }),
    );

    // #when
    const error = await failureOf(provider.startVerification({ to: PHONE }));

    // #then
    expect(error?.message).toBe("Telnyx Verify answered HTTP 400 (code 10015)");
    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("10015");
    expect(logged).not.toContain(PHONE.slice(4));
  });

  it("fails as a network error when Telnyx can't be reached", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider } = telnyx(() =>
      Promise.reject(new Error(`connect ECONNREFUSED ${PHONE}`)),
    );

    // #when
    const error = await failureOf(provider.startVerification({ to: PHONE }));

    // #then
    expect(error).toMatchObject({
      code: "NETWORK_ERROR",
      message: "Telnyx Verify unreachable",
    });
  });
});

describe("makeTelnyxVerify: checking", () => {
  it("posts the code to the number's verify action, keeping the plus", async () => {
    // #given
    const { provider, sent } = telnyx(
      reply(200, { data: { response_code: "accepted" } }),
    );

    // #when
    const result = await Effect.runPromise(
      provider.checkVerification({ to: PHONE, code: "246810" }),
    );

    // #then
    expect(result).toEqual({ approved: true });
    expect(sent[0]?.url).toBe(
      "https://api.telnyx.com/v2/verifications/by_phone_number/%2B254712345678/actions/verify",
    );
    expect(bodyOf(sent[0])).toEqual({
      code: "246810",
      verify_profile_id: PROFILE_ID,
    });
  });

  it.each([
    ["rejected", { approved: false, reason: "invalid" }],
    ["expired", { approved: false, reason: "expired" }],
    ["max_attempts_exceeded", { approved: false, reason: "max_attempts" }],
    ["something new", { approved: false, reason: "invalid" }],
  ])("reads response code %s as %o", async (responseCode, expected) => {
    // #given
    const { provider } = telnyx(
      reply(200, { data: { response_code: responseCode } }),
    );

    // #when
    const result = await Effect.runPromise(
      provider.checkVerification({ to: PHONE, code: "246810" }),
    );

    // #then
    expect(result).toEqual(expected);
  });

  it("reads a 404 as an expired or used code", async () => {
    // #given
    const { provider } = telnyx(reply(404, { errors: [{ code: "10005" }] }));

    // #when
    const result = await Effect.runPromise(
      provider.checkVerification({ to: PHONE, code: "246810" }),
    );

    // #then
    expect(result).toEqual({ approved: false, reason: "expired" });
  });

  it("never approves a reply it can't read", async () => {
    // #given
    const { provider } = telnyx(() =>
      Promise.resolve(new Response("<html>ok</html>", { status: 200 })),
    );

    // #when
    const result = await Effect.runPromise(
      provider.checkVerification({ to: PHONE, code: "246810" }),
    );

    // #then
    expect(result).toEqual({ approved: false, reason: "invalid" });
  });
});

describe("OtpProviderLive", () => {
  it("starts without Telnyx settings, and every call then fails as not configured", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const layer = OtpProviderLive.pipe(
      Layer.orDie,
      Layer.provide(
        Layer.setConfigProvider(
          ConfigProvider.fromMap(new Map([["TELNYX_API_KEY", API_KEY]])),
        ),
      ),
    );

    // #when
    const error = await failureOf(
      Effect.flatMap(OtpProvider, (otp) =>
        otp.startVerification({ to: PHONE }),
      ).pipe(Effect.provide(layer)),
    );

    // #then
    expect(error?.code).toBe("NOT_CONFIGURED");
  });
});
