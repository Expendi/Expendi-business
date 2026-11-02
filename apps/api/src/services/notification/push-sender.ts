import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

/**
 * Expo's push API over `fetch`, ported from the consumer backend's
 * `expo-push-service.ts` without expo-server-sdk
 * (https://docs.expo.dev/push-notifications/sending-notifications/):
 *   - send:     POST /--/api/v2/push/send, up to 100 messages, one ticket each
 *   - receipts: POST /--/api/v2/push/getReceipts, about 15 minutes later
 * Expo's error text can quote the token, so only HTTP statuses and Expo's
 * error codes reach our messages and logs.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const REQUEST_TIMEOUT_MS = 15_000;
export const PUSH_MESSAGES_PER_REQUEST = 100;
export const PUSH_RECEIPTS_PER_REQUEST = 300;

/** The Android channel the app creates at start-up (`apps/mobile/src/lib/push.ts`). */
export const PUSH_CHANNEL_ID = "default";

export class PushSendError extends Data.TaggedError("PushSendError")<{
  readonly message: string;
}> {}

export interface PushMessage {
  /** An Expo push token. */
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, string>>;
}

/** `error` is Expo's code, e.g. `DeviceNotRegistered`. */
export type PushOutcome =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly error: string | null };

/** Expo's answer for one message: accepted, with a receipt to check later, or refused. */
export type PushTicket =
  | { readonly status: "ok"; readonly id: string }
  | { readonly status: "error"; readonly error: string | null };

export interface PushSenderShape {
  /** One ticket per message, in the messages' order. */
  readonly send: (
    messages: readonly PushMessage[],
  ) => Effect.Effect<readonly PushTicket[], PushSendError>;
  /** Receipts Expo has for these tickets; one not ready yet is left out. */
  readonly receipts: (
    ticketIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, PushOutcome>, PushSendError>;
}

export class PushSender extends Context.Tag("PushSender")<
  PushSender,
  PushSenderShape
>() {}

export interface ExpoPushSettings {
  /** Only needed once "enhanced push security" is on for the Expo project. */
  readonly accessToken: Option.Option<Redacted.Redacted>;
}

const errorDetailsSchema = z
  .looseObject({ error: z.string().optional() })
  .optional();

const outcomeSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("ok") }),
  z.looseObject({ status: z.literal("error"), details: errorDetailsSchema }),
]);

const ticketSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("ok"), id: z.string().min(1) }),
  z.looseObject({ status: z.literal("error"), details: errorDetailsSchema }),
]);

const sendReplySchema = z.looseObject({ data: z.array(ticketSchema) });
const receiptsReplySchema = z.looseObject({
  data: z.record(z.string(), outcomeSchema),
});

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export function makeExpoPushSender(
  settings: ExpoPushSettings,
  fetchImpl: typeof fetch = fetch,
): PushSenderShape {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (Option.isSome(settings.accessToken)) {
    headers.Authorization = `Bearer ${Redacted.value(settings.accessToken.value)}`;
  }

  const post = <T>(
    url: string,
    body: unknown,
    schema: z.ZodType<T>,
    what: string,
  ): Effect.Effect<T, PushSendError> =>
    Effect.tryPromise({
      try: () =>
        fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        }),
      catch: () => new PushSendError({ message: `Expo ${what} unreachable` }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
              try: (): Promise<unknown> => response.json(),
              catch: () =>
                new PushSendError({
                  message: `Expo ${what} answered with something other than JSON`,
                }),
            })
          : Effect.fail(
              new PushSendError({
                message: `Expo ${what} answered HTTP ${response.status}`,
              }),
            ),
      ),
      Effect.flatMap((reply) => {
        const parsed = schema.safeParse(reply);
        return parsed.success
          ? Effect.succeed(parsed.data)
          : Effect.fail(
              new PushSendError({
                message: `Expo ${what} answered in an unexpected shape`,
              }),
            );
      }),
    );

  return {
    send: (messages) =>
      Effect.forEach(chunk(messages, PUSH_MESSAGES_PER_REQUEST), (batch) =>
        post(
          EXPO_PUSH_URL,
          batch.map((message) => ({
            ...message,
            sound: "default",
            priority: "high",
            channelId: PUSH_CHANNEL_ID,
          })),
          sendReplySchema,
          "push",
        ).pipe(
          Effect.flatMap(({ data }) =>
            data.length === batch.length
              ? Effect.succeed(
                  data.map((ticket): PushTicket =>
                    ticket.status === "ok"
                      ? { status: "ok", id: ticket.id }
                      : {
                          status: "error",
                          error: ticket.details?.error ?? null,
                        },
                  ),
                )
              : Effect.fail(
                  new PushSendError({
                    message: `Expo push answered ${data.length} tickets for ${batch.length} messages`,
                  }),
                ),
          ),
        ),
      ).pipe(Effect.map((batches) => batches.flat())),

    receipts: (ticketIds) =>
      Effect.forEach(chunk(ticketIds, PUSH_RECEIPTS_PER_REQUEST), (ids) =>
        post(EXPO_RECEIPTS_URL, { ids }, receiptsReplySchema, "receipts"),
      ).pipe(
        Effect.map(
          (replies) =>
            new Map(
              replies.flatMap(({ data }) =>
                Object.entries(data).map(
                  ([id, receipt]): [string, PushOutcome] => [
                    id,
                    receipt.status === "ok"
                      ? { status: "ok" }
                      : {
                          status: "error",
                          error: receipt.details?.error ?? null,
                        },
                  ],
                ),
              ),
            ),
        ),
      ),
  };
}

/**
 * Always on: Expo accepts pushes without an access token unless the
 * project's enhanced push security requires one (`EXPO_ACCESS_TOKEN`).
 */
export const PushSenderLive: Layer.Layer<PushSender, ConfigError.ConfigError> =
  Layer.effect(
    PushSender,
    Effect.gen(function* () {
      const accessToken = yield* Config.option(
        Config.redacted("EXPO_ACCESS_TOKEN"),
      );
      return makeExpoPushSender({ accessToken });
    }),
  );
