import type { LucideIcon } from "lucide-react-native";
import type { ComponentProps, JSX } from "react";
import type { Tabs } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CappedText } from "~/components/text";
import { colors } from "~/theme/colors";

export type TabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>["tabBar"]>
>[0];

export interface TabItem {
  /** The route name inside the tabs layout, e.g. "index" or "me/pay". */
  name: string;
  label: string;
  icon: LucideIcon;
}

export const TAB_BAR_HEIGHT = 56;

/** The tabs layout's bar: shows only `tabs`, so each role sees its own set. */
export function TabBar({
  state,
  navigation,
  tabs,
}: TabBarProps & { tabs: readonly TabItem[] }): JSX.Element {
  const available = tabs.filter((tab) =>
    state.routes.some((route) => route.name === tab.name),
  );
  return (
    <TabBarView
      tabs={available}
      selected={state.routes[state.index]?.name}
      onSelect={(name) => {
        const route = state.routes.find((entry) => entry.name === name);
        if (!route) return;
        const event = navigation.emit({
          type: "tabPress",
          target: route.key,
          canPreventDefault: true,
        });
        if (state.routes[state.index]?.name !== name && !event.defaultPrevented) {
          navigation.navigate(route.name, route.params);
        }
      }}
    />
  );
}

/**
 * A solid white tab bar. The selected tab gets a coral-700 outline icon on a
 * coral-50 pill and a coral-700 SemiBold label.
 */
export function TabBarView({
  tabs,
  selected,
  onSelect,
}: {
  tabs: readonly TabItem[];
  selected: string | undefined;
  onSelect: (name: string) => void;
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-gray-100 bg-white"
      style={{
        minHeight: TAB_BAR_HEIGHT + insets.bottom,
        paddingBottom: insets.bottom,
      }}
    >
      {tabs.map(({ name, label, icon: Icon }) => {
        const isSelected = selected === name;
        return (
          <Pressable
            key={name}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(name)}
            className="min-h-14 flex-1 items-center justify-center gap-0.5 py-1"
          >
            <View
              className={`h-8 w-14 items-center justify-center rounded-full ${isSelected ? "bg-brand-50" : ""}`}
            >
              <Icon
                size={22}
                strokeWidth={isSelected ? 2.25 : 1.75}
                color={isSelected ? colors.brandLink : colors.muted}
                accessible={false}
              />
            </View>
            <CappedText
              numberOfLines={1}
              size={11}
              maxScale={1.3}
              className={
                isSelected
                  ? "font-semibold text-brand-700"
                  : "font-medium text-gray-500"
              }
            >
              {label}
            </CappedText>
          </Pressable>
        );
      })}
    </View>
  );
}
