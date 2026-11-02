import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";

import type {
  PushMessage,
  PushOutcome,
  PushTicket,
} from "../../services/notification/push-sender.js";
import {
  PushSender,
  PushSendError,
} from "../../services/notification/push-sender.js";

const DEVICE_NOT_REGISTERED = "DeviceNotRegistered";

export const randomPushToken = (): string =>
  `ExponentPushToken[${randomBytes(16).toString("base64url")}]`;

/**
 * In-memory Expo push. `attempted` is every message handed to Expo,
 * `delivered` the ones it accepted. Steer the next sends with `failNext`
 * (Expo unreachable), `crashOnSend` (the process dies mid-send) and `hold`
 * (sends wait until released); `goneOnSend` and `goneOnReceipt` make Expo
 * report a token's app uninstalled.
 */
export function makeFakePushSender() {
  const attempted: PushMessage[] = [];
  const delivered: PushMessage[] = [];
  const receiptRequests: string[][] = [];
  const ticketTokens = new Map<string, string>();
  const goneOnSend = new Set<string>();
  const goneOnReceipt = new Set<string>();
  let failures = 0;
  let sendsUntilCrash = 0;
  let gate: Promise<void> | null = null;

  const state = {
    attempted,
    delivered,
    receiptRequests,
    /** What reached `token`'s device. */
    deliveredTo(token: string): PushMessage[] {
      return delivered.filter((message) => message.to === token);
    },
    attemptedTo(token: string): PushMessage[] {
      return attempted.filter((message) => message.to === token);
    },
    failNext(times = 1) {
      failures = times;
    },
    /** The `nth` send from now dies, as if the process crashed during it. */
    crashOnSend(nth = 1) {
      sendsUntilCrash = nth;
    },
    goneOnSend(token: string) {
      goneOnSend.add(token);
    },
    goneOnReceipt(token: string) {
      goneOnReceipt.add(token);
    },
    /** Sends wait until the returned function is called. */
    hold(): () => void {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
    reset() {
      attempted.length = 0;
      delivered.length = 0;
      receiptRequests.length = 0;
      ticketTokens.clear();
      goneOnSend.clear();
      goneOnReceipt.clear();
      failures = 0;
      sendsUntilCrash = 0;
      gate = null;
    },
  };

  const ticketFor = (message: PushMessage): PushTicket => {
    if (goneOnSend.has(message.to)) {
      return { status: "error", error: DEVICE_NOT_REGISTERED };
    }
    delivered.push(message);
    const id = randomUUID();
    ticketTokens.set(id, message.to);
    return { status: "ok", id };
  };

  const layer = Layer.succeed(PushSender, {
    send: (messages) =>
      Effect.gen(function* () {
        const held = gate;
        if (held) yield* Effect.promise(() => held);
        if (sendsUntilCrash > 0) {
          sendsUntilCrash -= 1;
          if (sendsUntilCrash === 0) {
            return yield* Effect.die(new Error("fake crash mid-send"));
          }
        }
        if (failures > 0) {
          failures -= 1;
          return yield* Effect.fail(
            new PushSendError({ message: "fake Expo unreachable" }),
          );
        }
        attempted.push(...messages);
        return messages.map(ticketFor);
      }),
    receipts: (ticketIds) =>
      Effect.sync(() => {
        receiptRequests.push([...ticketIds]);
        const receipts = new Map<string, PushOutcome>();
        for (const id of ticketIds) {
          const token = ticketTokens.get(id);
          if (token === undefined) continue;
          receipts.set(
            id,
            goneOnReceipt.has(token)
              ? { status: "error", error: DEVICE_NOT_REGISTERED }
              : { status: "ok" },
          );
        }
        return receipts;
      }),
  });
  return { layer, state };
}

export type FakePushSender = ReturnType<typeof makeFakePushSender>;
