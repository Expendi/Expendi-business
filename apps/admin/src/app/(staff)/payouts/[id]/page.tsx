import { PayoutView } from "./_components/payout-view";

export default async function PayoutPage({
  params,
}: PageProps<"/payouts/[id]">) {
  const { id } = await params;
  return <PayoutView payoutId={id} />;
}
