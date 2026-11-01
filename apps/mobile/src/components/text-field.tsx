import type { JSX } from "react";
import type { TextInputProps } from "react-native";
import { Text, TextInput, View } from "react-native";

interface TextFieldProps extends TextInputProps {
  label: string;
}

export function TextField({
  label,
  ...inputProps
}: TextFieldProps): JSX.Element {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-gray-700">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#9ca3af"
        className="min-h-14 rounded-xl border border-gray-300 bg-white px-4 text-base text-gray-900 focus:border-gray-900"
        {...inputProps}
      />
    </View>
  );
}
