import type { JSX } from "react";
import { Check, X } from "lucide-react-native";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";
import type { MonthChoice } from "./expenses-display";

/** A bottom sheet of months; `value` is "" for this month. */
export function MonthSheet({
  visible,
  choices,
  value,
  onSelect,
  onClose,
}: {
  visible: boolean;
  choices: readonly MonthChoice[];
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="absolute inset-0 bg-black/40"
          onPress={onClose}
        />
        <SafeAreaView
          edges={["bottom"]}
          accessibilityViewIsModal
          className="max-h-[80%] rounded-t-3xl bg-white"
        >
          <View className="flex-row items-center justify-between gap-3 px-5 pb-2 pt-6">
            <Text
              accessibilityRole="header"
              className="flex-1 text-[20px] font-semibold leading-7 text-gray-900"
            >
              Choose a month
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close month list"
              onPress={onClose}
              className="h-11 w-11 items-center justify-center rounded-full bg-gray-100 active:bg-gray-200"
            >
              <X size={20} color={colors.secondary} accessible={false} />
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="px-5 pb-4">
            {choices.map((choice) => {
              const selected = choice.value === value;
              return (
                <Pressable
                  key={choice.value === "" ? "current" : choice.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={choice.label}
                  onPress={() => onSelect(choice.value)}
                  className="min-h-14 flex-row items-center justify-between gap-3 border-b border-gray-100 py-3 active:opacity-70"
                >
                  <Text
                    className={`text-[17px] ${selected ? "font-semibold text-gray-900" : "text-gray-700"}`}
                  >
                    {choice.label}
                  </Text>
                  {selected ? (
                    <Check
                      size={20}
                      strokeWidth={2}
                      color={colors.brandStrong}
                      accessible={false}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
