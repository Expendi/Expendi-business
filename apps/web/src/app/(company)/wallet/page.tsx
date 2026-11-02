import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Wallet" };

export default function WalletPage(): JSX.Element {
  return <PlaceholderPage title="Wallet" task="T49" />;
}
