import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage(): JSX.Element {
  return <PlaceholderPage title="Settings" task="T49" />;
}
