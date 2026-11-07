import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { WalletView } from "./_components/wallet-view";

export const metadata: Metadata = { title: "Accounts" };

export default function WalletPage(): JSX.Element {
  return (
    <Suspense>
      <WalletView />
    </Suspense>
  );
}
