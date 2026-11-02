import type { PushPlatform } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { TestUser } from "./db.js";
import { sendJson } from "./claims.js";
import { randomPushToken } from "./push.js";

/** Registers a fresh token for `user`'s phone, as the app does after sign-in. */
export async function registerDevice(
  app: App,
  user: Pick<TestUser, "privyUserId">,
  token = randomPushToken(),
  platform: PushPlatform = "android",
): Promise<string> {
  const response = await sendJson(app, "/me/push-tokens", user, {
    method: "POST",
    body: { token, platform },
  });
  if (response.status !== 200) {
    throw new Error(`push-tokens answered ${response.status}`);
  }
  return token;
}
