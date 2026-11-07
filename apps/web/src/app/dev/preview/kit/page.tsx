import type { JSX } from "react";
import { notFound } from "next/navigation";

/** Dev only: every shared data component in its states (see ../README.md). */
export default async function KitPreviewRoute(): Promise<JSX.Element> {
  if (process.env.NODE_ENV === "development") {
    const { KitPreview } = await import("../_harness/kit-preview");
    return <KitPreview />;
  }
  notFound();
}
