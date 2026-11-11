import type { JSX } from "react";
import { View } from "react-native";

import { Text } from "~/components/text";

export interface KvRow {
  label: string;
  value: string;
  /** Puts the value under the label, for long text such as a note. */
  stacked?: boolean;
}

/** Label–value pairs in a soft grey group. */
export function KvGroup({ rows }: { rows: readonly KvRow[] }): JSX.Element {
  return (
    <View className="rounded-3xl bg-gray-50 px-4">
      {rows.map((row, index) => (
        <View
          key={row.label}
          accessible
          accessibilityLabel={`${row.label}: ${row.value}`}
          className={`py-4 ${index === 0 ? "" : "border-t border-gray-200/70"} ${row.stacked ? "" : "flex-row justify-between gap-4"}`}
        >
          <Text className="text-[15px] text-gray-600">{row.label}</Text>
          <Text
            selectable
            className={`text-[15px] font-medium text-gray-900 ${row.stacked ? "mt-1 leading-[22px]" : "min-w-0 flex-1 text-right"}`}
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}
