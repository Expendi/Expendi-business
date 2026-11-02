import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import {
  checkPushReceipts,
  sendPendingNotifications,
} from "../services/notification/delivery.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 5 seconds, send the notifications that events queued (spec §6.10).
 * Requests only write the outbox, so a slow or unreachable Expo never holds
 * one up.
 */
export const pushNotificationsJob: StationJob = {
  name: "push-notifications",
  everyMs: 5_000,
  lockKey: 72_020,
  run: sendPendingNotifications().pipe(
    Effect.map((summary) => (summary.considered === 0 ? IDLE : summary)),
  ),
};

/**
 * Every 5 minutes, read Expo's receipts for what was sent at least 15
 * minutes ago, and stop sending to apps Expo says are uninstalled.
 */
export const pushReceiptsJob: StationJob = {
  name: "push-receipts",
  everyMs: 5 * 60_000,
  lockKey: 72_021,
  run: checkPushReceipts().pipe(
    Effect.map((summary) => (summary.considered === 0 ? IDLE : summary)),
  ),
};
