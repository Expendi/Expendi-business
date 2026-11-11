/**
 * DEV PREVIEW — real screens on fixture data, no sign-in. Dev builds only.
 * `xcrun simctl openurl booted 'expendi-business://preview?screen=home'`
 */
import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { PreviewScreen } from "~/features/preview/types";
import { TAB_BAR_HEIGHT, TabBarView } from "~/components/tab-bar";
import { Text } from "~/components/text";
import { StaticCompanyProvider } from "~/features/company/company-provider";
import { ADMIN_TABS, MEMBER_TABS } from "~/features/company/tabs";
import { createPreviewApi } from "~/features/preview/fake-api";
import { PREVIEW_SCREENS, previewRoutes } from "~/features/preview/registry";
import { previewSession } from "~/features/preview/session";
import { ApiClientProvider } from "~/providers/api-provider";

export default function PreviewRoute(): JSX.Element {
  const { screen } = useLocalSearchParams<{ screen?: string }>();
  const router = useRouter();
  if (!__DEV__) return <Redirect href="/" />;
  const current =
    PREVIEW_SCREENS.find((entry) => entry.key === screen) ?? PREVIEW_SCREENS[0];
  if (!current) return <View />;
  const tabs = current.role === "admin" ? ADMIN_TABS : MEMBER_TABS;
  function show(next: PreviewScreen | undefined): void {
    if (next) router.setParams({ screen: next.key });
  }

  return (
    <View className="flex-1 bg-white">
      <PreviewProviders key={current.key} screen={current} />
      {current.tab ? (
        <TabBarView
          tabs={tabs}
          selected={current.tab}
          onSelect={(name) =>
            show(
              PREVIEW_SCREENS.find(
                (entry) => entry.tab === name && entry.role === current.role,
              ),
            )
          }
        />
      ) : null}
      <Switcher
        current={current}
        bottomOffset={current.tab ? TAB_BAR_HEIGHT + 12 : 140}
        onStep={(step) => {
          const index = PREVIEW_SCREENS.indexOf(current);
          const count = PREVIEW_SCREENS.length;
          show(PREVIEW_SCREENS[(index + step + count) % count]);
        }}
      />
    </View>
  );
}

function PreviewProviders({ screen }: { screen: PreviewScreen }): JSX.Element {
  const [queryClient] = useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [api] = useState(() => createPreviewApi(previewRoutes(screen)));
  const [session] = useState(() => previewSession(screen.role));
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={api}>
        <StaticCompanyProvider value={session}>
          <View className="flex-1">{screen.render()}</View>
        </StaticCompanyProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}

function Switcher({
  current,
  bottomOffset,
  onStep,
}: {
  current: PreviewScreen;
  bottomOffset: number;
  onStep: (step: number) => void;
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 items-center"
      style={{ bottom: insets.bottom + bottomOffset }}
    >
      <View className="h-11 flex-row items-center rounded-full bg-black px-1 opacity-90">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous preview"
          onPress={() => onStep(-1)}
          className="h-11 w-11 items-center justify-center"
        >
          <ChevronLeft size={20} color="#ffffff" />
        </Pressable>
        <Text className="text-[13px] font-semibold text-white">
          {`PREVIEW  ${current.name}`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next preview"
          onPress={() => onStep(1)}
          className="h-11 w-11 items-center justify-center"
        >
          <ChevronRight size={20} color="#ffffff" />
        </Pressable>
      </View>
    </View>
  );
}
