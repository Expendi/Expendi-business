import { Geist, Inter, Outfit } from "next/font/google";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
  preload: false,
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  preload: false,
});

/**
 * The CSS variables of every loadable font, for `<html>`. `app/styles.css`
 * picks one by `data-font`; only Outfit is preloaded.
 */
export const fontVariables = [outfit, geist, inter]
  .map((font) => font.variable)
  .join(" ");
