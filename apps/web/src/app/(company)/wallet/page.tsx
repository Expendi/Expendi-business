import type { Metadata } from "next";
import type { JSX } from "react";

import { WalletView } from "./_components/wallet-view";

export const metadata: Metadata = { title: "Wallet" };

export default function WalletPage(): JSX.Element {
  return <WalletView />;
}
