import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { CardsView } from "./_components/cards-view";

export const metadata: Metadata = { title: "Cards" };

export default function CardsPage(): JSX.Element {
  return (
    <Suspense>
      <CardsView />
    </Suspense>
  );
}
