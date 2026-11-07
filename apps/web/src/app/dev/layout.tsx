import type { ReactNode } from "react";
import { notFound } from "next/navigation";

/** Everything under `/dev` is for development only; production answers 404. */
export default function DevLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  if (process.env.NODE_ENV !== "development") notFound();
  return children;
}
