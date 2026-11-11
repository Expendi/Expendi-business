import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";

import { Providers } from "./providers";

import "~/app/styles.css";

import { TooltipProvider } from "~/components/ui/tooltip";
import { fontVariables } from "~/lib/fonts/registry";
import { preferenceAttributes } from "~/lib/preferences/preferences-config";
import { readPreferenceCookies } from "~/lib/preferences/preferences-server";
import { ThemeBootScript } from "~/lib/preferences/theme-boot-script";
import { PreferencesStoreProvider } from "~/stores/preferences/preferences-provider";

export const metadata: Metadata = {
  title: { default: "Expendi Business", template: "%s · Expendi Business" },
  description:
    "The Expendi Business dashboard for company admins and accountants",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  const { preferences, sidebarOpen } = await readPreferenceCookies();
  const dark = preferences.theme_mode === "dark";
  return (
    <html
      lang="en"
      className={cn(fontVariables, dark && "dark")}
      style={{ colorScheme: dark ? "dark" : "light" }}
      {...preferenceAttributes(preferences)}
      suppressHydrationWarning
    >
      <head>
        <ThemeBootScript />
      </head>
      <body className="min-h-screen font-sans">
        <PreferencesStoreProvider
          initialValues={preferences}
          sidebarOpen={sidebarOpen}
        >
          <TooltipProvider>
            <Providers>{children}</Providers>
          </TooltipProvider>
        </PreferencesStoreProvider>
      </body>
    </html>
  );
}
