import type { JSX } from "react";
import { Image } from "expo-image";
import { Snowflake } from "lucide-react-native";
import { useWindowDimensions, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

import type { ExpendiCard } from "@expendi-business/shared";

import { CappedText } from "~/components/text";
import { colors } from "~/theme/colors";
import engraving from "../../../assets/card-engrave.png";
import { cardFaceNumber } from "./card-display";

/** The printed card is drawn at 600 wide; everything on it scales from there. */
const DESIGN_WIDTH = 600;
const DESIGN_HEIGHT = 379;
const MAX_WIDTH = 420;
const SCREEN_GUTTERS = 40;

const MARK_PATHS = [
  "M 293.66 220.42 L 568.36 611.34 A 115.46 115.46 0 0 0 757.30 478.58 L 691.10 384.38 L 757.30 290.18 A 115.46 115.46 0 0 0 568.36 157.41 L 479.43 283.97",
  "M 665.20 548.33 L 390.50 157.41 A 115.46 115.46 0 0 0 201.56 290.18 L 267.75 384.38 L 201.56 478.58 A 115.46 115.46 0 0 0 390.50 611.34 L 479.43 484.79",
  "M 665.20 220.42 L 549.99 384.38",
  "M 293.66 548.33 L 408.87 384.38",
];

const INK_SHADOW = {
  textShadowColor: "rgba(90, 24, 10, 0.45)",
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
} as const;

/**
 * The Expendi card as it's printed: coral, engraved with the mark, the last
 * four and the holder's name. The full number only shows on Lithic's page.
 */
export function CardFace({
  card,
}: {
  card: Pick<ExpendiCard, "lastFour" | "nickname" | "holder" | "state">;
}): JSX.Element {
  const { width: screenWidth } = useWindowDimensions();
  const width = Math.min(screenWidth - SCREEN_GUTTERS, MAX_WIDTH);
  const at = (size: number): number => (size * width) / DESIGN_WIDTH;
  const height = at(DESIGN_HEIGHT);
  const radius = at(28);
  const holder = card.holder.name ?? card.holder.email;

  return (
    <View
      accessible
      accessibilityLabel={`${card.nickname} card ending ${card.lastFour}, held by ${holder}`}
      className="self-center"
      style={{
        width,
        height,
        borderRadius: radius,
        shadowColor: "#101828",
        shadowOpacity: 0.22,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 14 },
      }}
    >
      <View
        style={{
          flex: 1,
          borderRadius: radius,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: "rgba(255, 255, 255, 0.22)",
        }}
      >
        <Svg width={width} height={height} style={{ position: "absolute" }}>
          <Defs>
            <LinearGradient id="cardCoral" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#f8734f" />
              <Stop offset="0.46" stopColor="#e5532d" />
              <Stop offset="1" stopColor="#872f1e" />
            </LinearGradient>
            <LinearGradient id="cardChip" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#fde7c4" />
              <Stop offset="0.55" stopColor="#c89a59" />
              <Stop offset="1" stopColor="#8a5a1a" />
            </LinearGradient>
          </Defs>
          <Rect width={width} height={height} fill="url(#cardCoral)" />
          <Rect
            x={width - at(38) - at(62)}
            y={at(34)}
            width={at(62)}
            height={at(47)}
            rx={at(10)}
            fill="url(#cardChip)"
            stroke="rgba(70, 40, 10, 0.35)"
            strokeWidth={1}
          />
        </Svg>
        <Image
          source={engraving}
          contentFit="cover"
          accessible={false}
          style={{ position: "absolute", width, height, opacity: 0.2 }}
        />
        <Svg
          viewBox="151 79 657 611"
          width={at(58)}
          height={at(54)}
          style={{ position: "absolute", left: at(32), top: at(28) }}
        >
          {MARK_PATHS.map((d) => (
            <Path
              key={d}
              d={d}
              fill="none"
              stroke="#ffffff"
              strokeWidth={59.03}
              strokeLinecap="round"
              strokeLinejoin="miter"
            />
          ))}
        </Svg>
        <CappedText
          size={at(15)}
          maxScale={1}
          className="font-semibold"
          style={{
            position: "absolute",
            left: at(102),
            top: at(45),
            letterSpacing: at(3),
            color: "rgba(255, 255, 255, 0.9)",
          }}
        >
          VIRTUAL · USDC
        </CappedText>
        <CappedText
          size={at(30)}
          maxScale={1}
          className="font-medium text-white"
          style={{
            position: "absolute",
            left: at(34),
            top: at(212),
            letterSpacing: at(3),
            ...INK_SHADOW,
          }}
        >
          {cardFaceNumber(card.lastFour)}
        </CappedText>
        <FaceLine label="CARDHOLDER" value={holder} at={at} side="left" />
        <FaceLine label="VALID THRU" value="••/••" at={at} side="right" />
        {card.state === "open" ? null : (
          <View
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: "rgba(16, 24, 40, 0.45)" }}
          >
            <View className="flex-row items-center gap-2 rounded-full bg-white px-4 py-2">
              {card.state === "frozen" ? (
                <Snowflake size={16} strokeWidth={2} color={colors.text} />
              ) : null}
              <CappedText
                size={15}
                maxScale={1.2}
                className="font-semibold text-gray-900"
              >
                {card.state === "frozen" ? "Frozen" : "Closed"}
              </CappedText>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

function FaceLine({
  label,
  value,
  at,
  side,
}: {
  label: string;
  value: string;
  at: (size: number) => number;
  side: "left" | "right";
}): JSX.Element {
  return (
    <View
      style={{
        position: "absolute",
        bottom: at(28),
        [side]: side === "left" ? at(34) : at(38),
        maxWidth: at(300),
        alignItems: side === "left" ? "flex-start" : "flex-end",
      }}
    >
      <CappedText
        size={at(13)}
        maxScale={1}
        className="font-medium"
        style={{ letterSpacing: at(2), color: "rgba(255, 255, 255, 0.8)" }}
      >
        {label}
      </CappedText>
      <CappedText
        size={at(22)}
        maxScale={1}
        numberOfLines={1}
        className="font-semibold text-white"
        style={INK_SHADOW}
      >
        {value}
      </CappedText>
    </View>
  );
}
