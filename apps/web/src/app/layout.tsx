import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";

import { Providers } from "./providers";

import "~/app/styles.css";

import { Outfit } from "next/font/google";

import { TooltipProvider } from "~/components/ui/tooltip";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

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
    <html lang="en" className={outfit.variable}>
      <body className="min-h-screen font-sans">
        <TooltipProvider>
          <Providers>{children}</Providers>
        </TooltipProvider>
      </body>
    </html>
  );
}
