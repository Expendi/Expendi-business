import type { JSX } from "react";
import type { TextInputProps } from "react-native";
import { useId } from "react";
import { TextInput, View } from "react-native";

import { Text } from "~/components/text";

interface TextFieldProps extends TextInputProps {
  label: string;
  helper?: string;
  error?: string;
}

export function TextField({
  label,
  className,
  multiline,
  helper,
  error,
  editable = true,
  ...inputProps
}: TextFieldProps): JSX.Element {
  const labelId = useId();
  return (
    <View className="gap-2">
      <Text nativeID={labelId} className="text-sm font-medium text-gray-700">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={labelId}
        accessibilityHint={error ?? helper}
        aria-invalid={!!error}
        placeholderTextColor="#667085"
        multiline={multiline}
        editable={editable}
        textAlignVertical={multiline ? "top" : "center"}
        className={`min-h-[52px] rounded-xl border px-4 py-3 font-sans text-base text-gray-900 ${error ? "border-error-700" : "border-gray-300 focus:border-brand-700"} ${editable ? "bg-white" : "bg-gray-100 text-gray-500"} ${multiline ? "min-h-28" : ""} ${className ?? ""}`}
        {...inputProps}
      />
      {error ? (
        <Text
          selectable
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="text-sm leading-5 text-error-700"
        >
          {error}
        </Text>
      ) : helper ? (
        <Text className="text-sm leading-5 text-gray-600">{helper}</Text>
      ) : null}
    </View>
  );
}
