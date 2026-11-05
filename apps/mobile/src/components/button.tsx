import type { LucideIcon } from "lucide-react-native";
import type { JSX } from "react";
import type { PressableProps } from "react-native";
import { ActivityIndicator, Pressable } from "react-native";

import { Text } from "~/components/text";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<PressableProps, "children" | "disabled"> {
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
}

const CONTAINER_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-brand-500",
  secondary: "border border-gray-300 bg-white",
  ghost: "bg-transparent",
  danger: "bg-error-600",
};

const LABEL_CLASSES: Record<ButtonVariant, string> = {
  primary: "text-gray-900",
  secondary: "text-gray-900",
  ghost: "text-gray-600",
  danger: "text-white",
};

const SPINNER_COLORS: Record<ButtonVariant, string> = {
  primary: "#101828",
  secondary: "#101828",
  ghost: "#475467",
  danger: "#ffffff",
};

export function Button({
  label,
  variant = "primary",
  disabled = false,
  loading = false,
  className,
  icon: Icon,
  ...pressableProps
}: ButtonProps): JSX.Element {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      className={`min-h-[52px] flex-row items-center justify-center gap-2 rounded-xl px-4 py-3 active:opacity-80 ${CONTAINER_CLASSES[variant]} ${inactive ? "opacity-50" : ""} ${className ?? ""}`}
      {...pressableProps}
    >
      {loading ? (
        <ActivityIndicator color={SPINNER_COLORS[variant]} />
      ) : Icon ? (
        <Icon
          size={20}
          strokeWidth={1.75}
          color={SPINNER_COLORS[variant]}
          accessible={false}
        />
      ) : null}
      <Text
        className={`shrink text-center text-base font-semibold leading-6 ${LABEL_CLASSES[variant]}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
