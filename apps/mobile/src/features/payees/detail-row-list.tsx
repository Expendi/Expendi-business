import type { JSX } from "react";
import { Text, View } from "react-native";

import type { DetailRow } from "./payee-display";

export function DetailRowList({
  rows,
}: {
  rows: readonly DetailRow[];
}): JSX.Element {
  return (
    <View className="gap-4 rounded-2xl border border-gray-200 p-5">
      {rows.map((row) => (
        <View key={row.label} className="flex-row justify-between gap-4">
          <Text className="text-base text-gray-600">{row.label}</Text>
          <Text
            selectable
            className="flex-1 text-right text-base font-semibold text-gray-900"
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}
