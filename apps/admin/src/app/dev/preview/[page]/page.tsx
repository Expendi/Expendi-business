import type { JSX } from "react";
import { notFound } from "next/navigation";

/**
 * Dev only: an admin page in the real shell with sample data and no
 * sign-in (see ../README.md). Production builds leave the harness out and
 * answer 404.
 */
export default async function PagePreviewRoute({
  params,
  searchParams,
}: {
  params: Promise<{ page: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<JSX.Element> {
  if (process.env.NODE_ENV === "development") {
    const [{ page }, query] = await Promise.all([params, searchParams]);
    const { PagePreview } = await import("../_harness/page-preview");
    return (
      <PagePreview
        page={page}
        role={query.role === "viewer" ? "ops_viewer" : "ops_admin"}
      />
    );
  }
  notFound();
}
