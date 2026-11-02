import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage(): JSX.Element {
  return <PlaceholderPage title="Activity" task="T49" />;
}
