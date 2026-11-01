import type { PaycrestOrderRequest } from "./paycrest-client.js";
import type { KesPayoutQuote } from "./quote.js";
import type { PaycrestRecipient } from "./recipient.js";
import { fromMicro } from "./amounts.js";

/**
 * The Paycrest order for a quoted KES payout. `reference` is the payout's
 * own ID, so an order can always be matched back to the payout that made
 * it; `refundAddress` is the paying company's wallet, where a failed order
 * returns its USDC.
 */
export function buildOrderRequest(input: {
  readonly quote: KesPayoutQuote;
  readonly recipient: PaycrestRecipient;
  readonly reference: string;
  readonly refundAddress: string;
}): PaycrestOrderRequest {
  return {
    amount: fromMicro(input.quote.usdcAmount),
    amountIn: "crypto",
    rate: input.quote.rate,
    reference: input.reference,
    transactionFeePayer: "customer",
    source: {
      type: "crypto",
      currency: "USDC",
      network: "base",
      refundAddress: input.refundAddress,
    },
    destination: {
      type: "fiat",
      currency: "KES",
      country: "KE",
      providerIds: input.quote.providerIds,
      recipient: input.recipient,
    },
  };
}
