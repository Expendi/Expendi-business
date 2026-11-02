import type { Metadata } from "next";
import type { JSX } from "react";

import { PayeesView } from "./_components/payees-view";

export const metadata: Metadata = { title: "Payees" };

export default function PayeesPage(): JSX.Element {
  return <PayeesView />;
}
