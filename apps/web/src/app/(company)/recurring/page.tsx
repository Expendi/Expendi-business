import { redirect } from "next/navigation";

import { recurringRedirect } from "./recurring-redirect";

/**
 * Recurring payments live in the Bills page's side sheet now: the list,
 * or one payment when a link names it (`?itemId=`).
 */
export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const { itemId } = await searchParams;
  redirect(recurringRedirect(itemId));
}
