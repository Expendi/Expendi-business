import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";

import { Providers } from "./providers";

import "~/app/styles.css";

export const metadata: Metadata = {
  title: { default: "Expendi Business", template: "%s · Expendi Business" },
  description:
    "The Expendi Business dashboard for company admins and accountants",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
