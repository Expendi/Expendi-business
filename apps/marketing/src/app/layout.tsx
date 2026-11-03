import type { Metadata, Viewport } from "next";
import type { JSX, ReactNode } from "react";
import localFont from "next/font/local";

import "./globals.css";

const qontoSans = localFont({
  src: [
    {
      path: "../../public/qonto/static/qontosans-light.woff2",
      weight: "300",
      style: "normal",
    },
    {
      path: "../../public/qonto/static/qontosans-regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../public/qonto/static/qontosans-semibold.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../../public/qonto/static/qontosans-bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-qonto-sans",
  display: "swap",
});

const title = "Manage all your finances from your Qonto business account ";
const description =
  "A business account - and much more. ✓ Invoicing ✓ Bookkeeping ✓ Expense management ✓ Financing | 7/7 customer support";

export const metadata: Metadata = {
  title,
  description,
  robots: { index: false, follow: false },
  icons: {
    icon: "/seo/favicon.png",
    apple: { url: "/seo/apple-touch-icon.png", sizes: "180x180" },
    other: [{ rel: "mask-icon", url: "/seo/safari-pinned-tab.svg" }],
  },
  openGraph: {
    siteName: "Qonto",
    title,
    description,
    type: "website",
    images: ["/seo/og-image.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/seo/og-image.jpg"],
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html lang="en" className={qontoSans.variable}>
      <body>{children}</body>
    </html>
  );
}
