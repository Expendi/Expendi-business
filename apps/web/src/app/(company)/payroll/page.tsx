import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Payroll" };

export default function PayrollPage(): JSX.Element {
  return <PlaceholderPage title="Payroll" task="T48" />;
}
