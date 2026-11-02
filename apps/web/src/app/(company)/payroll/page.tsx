import type { Metadata } from "next";
import type { JSX } from "react";

import { PayrollView } from "./_components/payroll-view";

export const metadata: Metadata = { title: "Payroll" };

export default function PayrollPage(): JSX.Element {
  return <PayrollView />;
}
