import type { JSX } from "react";
import type { PressableProps } from "react-native";
import { ActivityIndicator, Pressable, Text } from "react-native";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<PressableProps, "children" | "disabled"> {
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
}

const CONTAINER_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-gray-900",
  secondary: "border border-gray-300 bg-white",
  ghost: "bg-transparent",
  danger: "bg-error-600",
};

const LABEL_CLASSES: Record<ButtonVariant, string> = {
  primary: "text-white",
  secondary: "text-gray-900",
  ghost: "text-gray-600",
  danger: "text-white",
};

const SPINNER_COLORS: Record<ButtonVariant, string> = {
  primary: "#ffffff",
  secondary: "#111827",
  ghost: "#4b5563",
  danger: "#ffffff",
};

export function Button({
  label,
  variant = "primary",
  disabled = false,
  loading = false,
  ...pressableProps
}: ButtonProps): JSX.Element {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      className={`min-h-14 flex-row items-center justify-center gap-2 rounded-xl px-4 active:opacity-80 ${CONTAINER_CLASSES[variant]} ${inactive ? "opacity-50" : ""}`}
      {...pressableProps}
    >
      {loading ? <ActivityIndicator color={SPINNER_COLORS[variant]} /> : null}
      <Text className={`text-base font-semibold ${LABEL_CLASSES[variant]}`}>
        {label}
      </Text>
    </Pressable>
  );
}
