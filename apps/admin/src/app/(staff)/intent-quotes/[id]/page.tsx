import { IntentQuoteView } from "./_components/intent-quote-view";

export default async function IntentQuotePage({
  params,
}: PageProps<"/intent-quotes/[id]">) {
  const { id } = await params;
  return <IntentQuoteView quoteId={id} />;
}
