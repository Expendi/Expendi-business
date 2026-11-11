import type { JSX } from "react";
import { View } from "react-native";

import { CappedText } from "~/components/text";

const TABULAR = { fontVariant: ["tabular-nums" as const] };
/** The figure is already display-sized; past this it pushes everything off screen. */
const MAX_SCALE = 1.25;

const SIZES = {
  lg: { whole: 46, lineHeight: 54, tracking: -1.2, fraction: 26, code: 20 },
  md: { whole: 36, lineHeight: 44, tracking: -0.8, fraction: 22, code: 18 },
} as const;

/**
 * The big figure: the currency code and the cents small and muted, the whole
 * units Regular in ink. `value` is already formatted, e.g. "121,282.82".
 */
export function MoneyFigure({
  code,
  value,
  size = "lg",
  hidden = false,
}: {
  code: "KES" | "USDC";
  value: string;
  size?: keyof typeof SIZES;
  /** Masks the amount when the person has hidden their balance. */
  hidden?: boolean;
}): JSX.Element {
  const scale = SIZES[size];
  const [whole = "0", fraction] = value.split(".");
  const wholeStyle = { letterSpacing: scale.tracking, ...TABULAR };
  return (
    <View
      accessible
      accessibilityLabel={hidden ? "Amount hidden" : `${code} ${value}`}
      className="flex-row flex-wrap items-baseline"
    >
      <CappedText
        size={scale.code}
        maxScale={MAX_SCALE}
        className="mr-2 font-medium text-gray-500"
      >
        {code}
      </CappedText>
      {hidden ? (
        <CappedText
          size={scale.whole}
          lineHeight={scale.lineHeight}
          maxScale={MAX_SCALE}
          className="font-normal text-gray-900"
        >
          ••••••
        </CappedText>
      ) : (
        <>
          <CappedText
            size={scale.whole}
            lineHeight={scale.lineHeight}
            maxScale={MAX_SCALE}
            className="font-normal text-gray-900"
            style={wholeStyle}
          >
            {whole}
          </CappedText>
          {fraction === undefined ? null : (
            <CappedText
              size={scale.fraction}
              maxScale={MAX_SCALE}
              className="font-normal text-gray-500"
              style={TABULAR}
            >
              {`.${fraction}`}
            </CappedText>
          )}
        </>
      )}
    </View>
  );
}
