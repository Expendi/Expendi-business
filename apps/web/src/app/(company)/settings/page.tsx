import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { SettingsView } from "./_components/settings-view";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage(): JSX.Element {
  return (
    <Suspense>
      <SettingsView />
    </Suspense>
  );
}
