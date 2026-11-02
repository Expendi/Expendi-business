import type { Metadata } from "next";
import type { JSX } from "react";

import { ActivityView } from "./_components/activity-view";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage(): JSX.Element {
  return <ActivityView />;
}
