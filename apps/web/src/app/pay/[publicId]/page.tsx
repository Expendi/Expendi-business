import type { Metadata } from "next";
import type { JSX } from "react";

import { PayPage } from "./_components/pay-page";

export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The page a customer opens from an invoice email. The public ID in the URL
 * is the whole credential: there is no account, so it sits outside Privy
 * (see `STANDALONE_PATH_PREFIXES` in `providers.tsx`).
 */
export default async function PayRoute({
  params,
}: {
  params: Promise<{ publicId: string }>;
}): Promise<JSX.Element> {
  const { publicId } = await params;
  return <PayPage publicId={publicId} />;
}
