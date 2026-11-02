import type { Metadata } from "next";
import type { JSX } from "react";

import { RecurringView } from "./_components/recurring-view";

export const metadata: Metadata = { title: "Recurring" };

export default function RecurringPage(): JSX.Element {
  return <RecurringView />;
}
