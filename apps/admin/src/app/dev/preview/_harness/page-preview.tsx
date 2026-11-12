"use client";

import type { JSX } from "react";
import Link from "next/link";
import { Suspense } from "react";

import type { StaffRole } from "@expendi-business/shared";

import { STAFF, VIEWER_STAFF } from "./fixtures/ids";
import { PAGE_PREVIEWS } from "./pages";
import { PreviewProviders } from "./preview-providers";

export function PagePreview({
  page,
  role,
}: {
  page: string;
  role: StaffRole;
}): JSX.Element {
  const preview = PAGE_PREVIEWS[page];
  if (!preview) {
    return (
      <main className="mx-auto max-w-xl p-8 text-sm">
        <h1 className="text-2xl leading-8">No preview called “{page}”</h1>
        <ul className="mt-4 list-disc pl-5">
          {Object.keys(PAGE_PREVIEWS).map((name) => (
            <li key={name}>
              <Link className="underline" href={`/dev/preview/${name}`}>
                {name}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  const { View, path, seed } = preview;
  return (
    <PreviewProviders
      staff={role === "ops_viewer" ? VIEWER_STAFF : STAFF}
      currentPath={path}
      seed={seed}
    >
      <Suspense>
        <View />
      </Suspense>
    </PreviewProviders>
  );
}
