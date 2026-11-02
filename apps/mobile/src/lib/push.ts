import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { PushPlatform } from "@expendi-business/shared";
import {
  registerPushTokenResponseSchema,
  unregisterPushTokenResponseSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "./api";

/**
 * Push notifications through Expo (spec §6.10), ported from the consumer
 * app's `push-notifications.ts`. The token is registered with the API after
 * sign-in and unregistered on sign-out, so a phone handed to someone else
 * stops showing the last person's claims.
 */

/** The Android channel `app.config.ts` names as default and the API sends to. */
export const PUSH_CHANNEL_ID = "default";

const REGISTERED_TOKEN_KEY = "push-token";
const PERMISSION_ASKED_KEY = "push-permission-asked";

/** Shows notifications that arrive while the app is open, and creates the Android channel. */
export async function setUpNotifications(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
  });
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_ID, {
    name: "Claims and payments",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#111827",
  });
}

/** `ask`: the system prompt can still be shown. */
export type PushPermission = "granted" | "ask" | "denied";

export async function pushPermission(): Promise<PushPermission> {
  const permission = await Notifications.getPermissionsAsync();
  if (permission.granted) return "granted";
  return permission.canAskAgain ? "ask" : "denied";
}

export async function requestPushPermission(): Promise<boolean> {
  const permission = await Notifications.requestPermissionsAsync();
  return permission.granted;
}

/** The app explains notifications once per device, whatever the answer. */
export async function wasAskedAboutPush(): Promise<boolean> {
  return (await SecureStore.getItemAsync(PERMISSION_ASKED_KEY)) !== null;
}

export function rememberAskedAboutPush(): Promise<void> {
  return SecureStore.setItemAsync(PERMISSION_ASKED_KEY, "1");
}

function projectIdFromExtra(extra: unknown): string | null {
  if (typeof extra !== "object" || extra === null || !("eas" in extra)) {
    return null;
  }
  const { eas } = extra;
  if (typeof eas !== "object" || eas === null || !("projectId" in eas)) {
    return null;
  }
  return typeof eas.projectId === "string" ? eas.projectId : null;
}

function pushPlatform(): PushPlatform | null {
  return Platform.OS === "ios" || Platform.OS === "android"
    ? Platform.OS
    : null;
}

/**
 * This install's Expo push token, or null where there is none: a simulator,
 * or a build without push credentials (FCM on Android, APNs on iOS).
 */
export async function getPushToken(): Promise<string | null> {
  const projectId =
    Constants.easConfig?.projectId ??
    projectIdFromExtra(Constants.expoConfig?.extra);
  if (!pushPlatform() || !projectId) return null;
  try {
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data;
  } catch (error) {
    console.warn("[push] couldn't get a push token", error);
    return null;
  }
}

export async function registerPushToken(
  api: ApiClient,
  token: string,
): Promise<void> {
  const platform = pushPlatform();
  if (!platform) return;
  await api.post(
    "/me/push-tokens",
    { token, platform },
    registerPushTokenResponseSchema,
  );
  await SecureStore.setItemAsync(REGISTERED_TOKEN_KEY, token);
}

/** On sign-out, before the session ends: this phone stops getting the person's notifications. */
export async function unregisterPushToken(api: ApiClient): Promise<void> {
  const token = await SecureStore.getItemAsync(REGISTERED_TOKEN_KEY);
  if (!token) return;
  try {
    await api.delete(
      `/me/push-tokens/${encodeURIComponent(token)}`,
      unregisterPushTokenResponseSchema,
    );
  } finally {
    await SecureStore.deleteItemAsync(REGISTERED_TOKEN_KEY);
  }
}
