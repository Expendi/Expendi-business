import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Expenses" };

export default function ExpensesPage(): JSX.Element {
  return <PlaceholderPage title="Expenses" task="T47" />;
}
