import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "./providers";

import "~/app/styles.css";

export const metadata: Metadata = {
  title: "Expendi Business Ops",
  description: "Internal admin app for the Expendi team",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
