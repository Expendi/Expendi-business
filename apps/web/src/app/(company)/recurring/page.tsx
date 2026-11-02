import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Recurring" };

export default function RecurringPage(): JSX.Element {
  return <PlaceholderPage title="Recurring" task="T48" />;
}
