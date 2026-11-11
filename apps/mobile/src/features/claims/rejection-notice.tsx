import type { JSX } from "react";
import { Undo2 } from "lucide-react-native";
import { View } from "react-native";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

/** Why an admin returned a reimbursement, for the person who submitted it. */
export function RejectionNotice({ reason }: { reason: string }): JSX.Element {
  return (
    <View
      accessibilityRole="summary"
      className="flex-row items-start gap-3 rounded-2xl bg-brand-50 p-4"
    >
      <Undo2
        size={20}
        strokeWidth={1.75}
        color={colors.brandStrong}
        accessible={false}
      />
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-[15px] font-semibold text-gray-900">
          Why it was returned
        </Text>
        <Text selectable className="text-[15px] leading-[21px] text-gray-900">
          {reason}
        </Text>
        <Text className="text-[14px] leading-5 text-gray-600">
          Fix what’s needed and resubmit it for approval.
        </Text>
      </View>
    </View>
  );
}
