import type { JSX, ReactNode } from "react";
import type { Edge } from "react-native-safe-area-context";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const ALL_EDGES: Edge[] = ["top", "right", "bottom", "left"];
const BELOW_HEADER_EDGES: Edge[] = ["right", "bottom", "left"];

interface ScreenProps {
  children: ReactNode;
  /** True when a native stack header already covers the top inset. */
  belowHeader?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function Screen({
  children,
  belowHeader = false,
  refreshing = false,
  onRefresh,
}: ScreenProps): JSX.Element {
  return (
    <SafeAreaView
      edges={belowHeader ? BELOW_HEADER_EDGES : ALL_EDGES}
      className="flex-1 bg-white"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName={`grow gap-8 px-6 ${belowHeader ? "py-6" : "py-8"}`}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
