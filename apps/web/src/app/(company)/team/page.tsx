import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { TeamView } from "./_components/team-view";

export const metadata: Metadata = { title: "Team" };

export default function TeamPage(): JSX.Element {
  return (
    <Suspense>
      <TeamView />
    </Suspense>
  );
}
