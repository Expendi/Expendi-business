import type { JSX, ReactNode } from "react";
import type { Edge } from "react-native-safe-area-context";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors } from "~/theme/colors";

const ALL_EDGES: Edge[] = ["top", "right", "bottom", "left"];
const BELOW_HEADER_EDGES: Edge[] = ["right", "bottom", "left"];

interface ScreenProps {
  children: ReactNode;
  /** True when a native stack header already covers the top inset. */
  belowHeader?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  centered?: boolean;
}

export function Screen({
  children,
  belowHeader = false,
  refreshing = false,
  onRefresh,
  centered = false,
}: ScreenProps): JSX.Element {
  return (
    <SafeAreaView
      edges={belowHeader ? BELOW_HEADER_EDGES : ALL_EDGES}
      className="flex-1 bg-gray-50"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName={`mx-auto w-full max-w-3xl grow gap-6 px-5 ${belowHeader ? "py-6" : "py-8"} ${centered ? "justify-center" : ""}`}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.brandStrong}
                colors={[colors.brandStrong]}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
