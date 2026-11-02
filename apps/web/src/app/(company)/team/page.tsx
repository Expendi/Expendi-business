import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Team" };

export default function TeamPage(): JSX.Element {
  return <PlaceholderPage title="Team" task="T49" />;
}
