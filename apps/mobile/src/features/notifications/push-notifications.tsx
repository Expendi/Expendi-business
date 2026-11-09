import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "~/features/auth/auth-provider";
import { useCompanySession } from "~/features/company/company-provider";
import {
  notificationHref,
  notificationQueryKey,
  notificationTarget,
} from "~/lib/notification-target";
import {
  getPushToken,
  pushPermission,
  registerPushToken,
  rememberAskedAboutPush,
  requestPushPermission,
  setUpNotifications,
  unregisterPushToken,
  wasAskedAboutPush,
} from "~/lib/push";
import { useApi } from "~/providers/api-provider";
import { PushPrePrompt } from "./push-pre-prompt";

const warn = (what: string) => (error: unknown) => {
  console.warn(`[push] ${what}`, error);
};

/**
 * Push for the signed-in person (spec §6.10): registers this phone once
 * they've reached the app (asking first, once, if the system hasn't yet),
 * unregisters it on sign-out, and opens the claim or card a tapped
 * notification is about, in its company.
 */
export function PushNotifications(): JSX.Element {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { addSignOutTask } = useAuth();
  const { state, selectCompany } = useCompanySession();
  const lastResponse = Notifications.useLastNotificationResponse();
  const [prompting, setPrompting] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const registeredFor = useRef<string | null>(null);
  const openedResponse = useRef<string | null>(null);

  const reachedApp =
    state.status === "ready" && state.me.user.fullName !== null;
  const userId = reachedApp ? state.me.user.id : null;
  const companies =
    state.status === "ready" || state.status === "choose"
      ? state.companies
      : null;

  const register = useCallback(async () => {
    const token = await getPushToken();
    if (token) await registerPushToken(api, token);
  }, [api]);

  useEffect(() => {
    setUpNotifications().catch(warn("couldn't set up notifications"));
  }, []);

  useEffect(
    () => addSignOutTask(() => unregisterPushToken(api)),
    [addSignOutTask, api],
  );

  useEffect(() => {
    if (!userId || registeredFor.current === userId) return;
    registeredFor.current = userId;
    void (async () => {
      const permission = await pushPermission();
      if (permission === "granted") {
        await register();
      } else if (permission === "ask" && !(await wasAskedAboutPush())) {
        setPrompting(true);
      }
    })().catch(warn("couldn't register this phone"));
  }, [userId, register]);

  useEffect(() => {
    if (
      lastResponse?.actionIdentifier !==
        Notifications.DEFAULT_ACTION_IDENTIFIER ||
      !companies
    ) {
      return;
    }
    const { identifier, content } = lastResponse.notification.request;
    if (openedResponse.current === identifier) return;
    openedResponse.current = identifier;
    Notifications.clearLastNotificationResponse();

    const target = notificationTarget(content.data);
    const company = companies.find(
      ({ organizationId }) => organizationId === target?.organizationId,
    );
    if (!target || !company) return;
    selectCompany(company.organizationId);
    void queryClient.invalidateQueries({
      queryKey: notificationQueryKey(target),
    });
    router.push(notificationHref(target));
  }, [lastResponse, companies, selectCompany, queryClient, router]);

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(
      ({ request }) => {
        const target = notificationTarget(request.content.data);
        if (!target) return;
        void queryClient.invalidateQueries({
          queryKey: notificationQueryKey(target),
        });
      },
    );
    return () => subscription.remove();
  }, [queryClient]);

  async function allow(): Promise<void> {
    setAllowing(true);
    try {
      await rememberAskedAboutPush();
      if (await requestPushPermission()) await register();
    } catch (error) {
      warn("couldn't turn on notifications")(error);
    } finally {
      setAllowing(false);
      setPrompting(false);
    }
  }

  function notNow(): void {
    setPrompting(false);
    rememberAskedAboutPush().catch(warn("couldn't remember the answer"));
  }

  return (
    <PushPrePrompt
      visible={prompting}
      busy={allowing}
      onAllow={() => void allow()}
      onNotNow={notNow}
    />
  );
}
