import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Bills" };

export default function BillsPage(): JSX.Element {
  return <PlaceholderPage title="Bills" task="T48" />;
}
