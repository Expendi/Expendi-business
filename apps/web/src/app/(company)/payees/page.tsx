import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Payees" };

export default function PayeesPage(): JSX.Element {
  return <PlaceholderPage title="Payees" task="T48" />;
}
