import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
} from "effect";
import { describe, expect, it } from "vitest";

import type { PushMessage } from "../../services/notification/push-sender.js";
import {
  makeExpoPushSender,
  PushSender,
  PushSenderLive,
} from "../../services/notification/push-sender.js";
import { randomPushToken } from "../helpers/push.js";

const ACCESS_TOKEN = "expo_test_access_token";

interface Request {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function message(to = randomPushToken()): PushMessage {
  return {
    to,
    title: "Claim paid",
    body: "Your claim for KES 1,500 at Java was paid.",
    data: { type: "claim_paid", organizationId: "org", claimId: "claim" },
  };
}

function expo(
  respond: (body: unknown) => Response | Promise<Response>,
  accessToken: string | null = null,
) {
  const requests: Request[] = [];
  const sender = makeExpoPushSender(
    {
      accessToken:
        accessToken === null
          ? Option.none()
          : Option.some(Redacted.make(accessToken)),
    },
    async (input, init) => {
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
        body,
      });
      return respond(body);
    },
  );
  return { sender, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Expo's answer: one ok ticket per message. */
const ticketsFor = (body: unknown) =>
  json({
    data: (Array.isArray(body) ? body : []).map((_, index) => ({
      status: "ok",
      id: `ticket-${index}`,
    })),
  });

function idsAskedFor(body: unknown): number {
  return typeof body === "object" &&
    body !== null &&
    "ids" in body &&
    Array.isArray(body.ids)
    ? body.ids.length
    : 0;
}

async function failureMessage<A, E extends { message: string }>(
  effect: Effect.Effect<A, E>,
): Promise<string | null> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.failureOption(exit.cause))?.message ?? null;
}

describe("makeExpoPushSender: send", () => {
  it("posts the messages to Expo with sound, high priority and the app's channel", async () => {
    // #given
    const { sender, requests } = expo(ticketsFor);
    const one = message();

    // #when
    await Effect.runPromise(sender.send([one]));

    // #then
    expect(requests.map(({ url, body }) => ({ url, body }))).toEqual([
      {
        url: "https://exp.host/--/api/v2/push/send",
        body: [
          { ...one, sound: "default", priority: "high", channelId: "default" },
        ],
      },
    ]);
  });

  it("sends no Authorization header without an access token", async () => {
    // #given
    const { sender, requests } = expo(ticketsFor);

    // #when
    await Effect.runPromise(sender.send([message()]));

    // #then
    expect(requests[0]?.headers.has("authorization")).toBe(false);
  });

  it("sends the access token when one is set", async () => {
    // #given
    const { sender, requests } = expo(ticketsFor, ACCESS_TOKEN);

    // #when
    await Effect.runPromise(sender.send([message()]));

    // #then
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
  });

  it("sends at most 100 messages a request, and returns the tickets in order", async () => {
    // #given
    let issued = 0;
    const { sender, requests } = expo((body) =>
      json({
        data: (Array.isArray(body) ? body : []).map(() => ({
          status: "ok",
          id: `ticket-${issued++}`,
        })),
      }),
    );
    const messages = Array.from({ length: 250 }, () => message());

    // #when
    const tickets = await Effect.runPromise(sender.send(messages));

    // #then
    expect({
      sizes: requests.map(({ body }) =>
        Array.isArray(body) ? body.length : 0,
      ),
      first: tickets[0],
      last: tickets.at(-1),
      count: tickets.length,
    }).toEqual({
      sizes: [100, 100, 50],
      first: { status: "ok", id: "ticket-0" },
      last: { status: "ok", id: "ticket-249" },
      count: 250,
    });
  });

  it("keeps Expo's error code for a refused message, and never its text", async () => {
    // #given
    const token = randomPushToken();
    const { sender } = expo(() =>
      json({
        data: [
          {
            status: "error",
            message: `"${token}" is not a registered push notification recipient`,
            details: { error: "DeviceNotRegistered", expoPushToken: token },
          },
        ],
      }),
    );

    // #when
    const tickets = await Effect.runPromise(sender.send([message(token)]));

    // #then
    expect(tickets).toEqual([
      { status: "error", error: "DeviceNotRegistered" },
    ]);
  });

  it.each([
    ["answers HTTP 500", () => json({ errors: [{ code: "INTERNAL" }] }, 500)],
    ["answers something other than JSON", () => new Response("<html>")],
    ["answers in another shape", () => json({ result: "ok" })],
    ["answers fewer tickets than messages", () => json({ data: [] })],
    ["can't be reached", () => Promise.reject(new TypeError("fetch failed"))],
  ])("fails without naming the token when Expo %s", async (_label, respond) => {
    // #given
    const token = randomPushToken();
    const { sender } = expo(respond);

    // #when
    const failure = await failureMessage(sender.send([message(token)]));

    // #then
    expect(failure).toMatch(/^Expo push /);
    expect(failure).not.toContain(token);
  });
});

describe("makeExpoPushSender: receipts", () => {
  it("asks for at most 300 receipts a request", async () => {
    // #given
    const { sender, requests } = expo(() => json({ data: {} }));
    const ids = Array.from({ length: 700 }, (_, index) => `ticket-${index}`);

    // #when
    await Effect.runPromise(sender.receipts(ids));

    // #then
    expect(
      requests.map(({ url, body }) => ({
        url,
        size: idsAskedFor(body),
      })),
    ).toEqual([
      { url: "https://exp.host/--/api/v2/push/getReceipts", size: 300 },
      { url: "https://exp.host/--/api/v2/push/getReceipts", size: 300 },
      { url: "https://exp.host/--/api/v2/push/getReceipts", size: 100 },
    ]);
  });

  it("returns each receipt Expo has, with its error code", async () => {
    // #given
    const { sender } = expo(() =>
      json({
        data: {
          "ticket-1": { status: "ok" },
          "ticket-2": {
            status: "error",
            message: "The device cannot receive push notifications",
            details: { error: "DeviceNotRegistered" },
          },
        },
      }),
    );

    // #when
    const receipts = await Effect.runPromise(
      sender.receipts(["ticket-1", "ticket-2", "ticket-3"]),
    );

    // #then
    expect([...receipts]).toEqual([
      ["ticket-1", { status: "ok" }],
      ["ticket-2", { status: "error", error: "DeviceNotRegistered" }],
    ]);
  });
});

describe("PushSenderLive", () => {
  it("starts without EXPO_ACCESS_TOKEN", async () => {
    // #given
    const layer = PushSenderLive.pipe(
      Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map()))),
    );

    // #when
    const exit = await Effect.runPromiseExit(Effect.provide(PushSender, layer));

    // #then
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
