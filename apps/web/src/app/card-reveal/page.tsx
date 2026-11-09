import type { Metadata } from "next";
import type { JSX } from "react";

import { CardReveal } from "./_components/card-reveal";

export const metadata: Metadata = {
  title: "Card details",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Shows one card's number, CVV and expiry through Lithic's embed. Opened
 * from a fresh passkey check with a short-lived session in the URL
 * fragment; there is no account on this page.
 */
export default function CardRevealPage(): JSX.Element {
  return <CardReveal />;
}
