import type { JSX } from "react";
import { View } from "react-native";

import type { DetailRow } from "./payee-display";
import { Text } from "~/components/text";

export function DetailRowList({
  rows,
}: {
  rows: readonly DetailRow[];
}): JSX.Element {
  return (
    <View className="gap-4 rounded-xl border border-gray-200 bg-white p-4">
      {rows.map((row) => (
        <View key={row.label} className="flex-row justify-between gap-4">
          <Text className="flex-1 text-sm text-gray-600">{row.label}</Text>
          <Text
            selectable
            className="flex-1 text-right text-sm font-medium text-gray-900"
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}
