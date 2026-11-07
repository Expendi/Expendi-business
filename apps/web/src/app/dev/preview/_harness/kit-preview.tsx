"use client";

import type { JSX } from "react";
import { Suspense } from "react";

import { KitGallery } from "./kit-gallery";
import { PreviewProviders } from "./preview-providers";

export function KitPreview(): JSX.Element {
  return (
    <PreviewProviders role="admin" currentPath="/dev/preview/kit">
      <Suspense>
        <KitGallery />
      </Suspense>
    </PreviewProviders>
  );
}
