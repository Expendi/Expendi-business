"use client";

import type { JSX } from "react";

import { TreasuryOfferButton } from "~/app/(company)/wallet/_components/treasury-offer";
import { Banner, Banners } from "~/components/data/banner";
import { PageHeader } from "~/components/data/page-header";
import { Button } from "~/components/ui/button";
import { describePaymentError } from "~/features/bills/bill-payment";
import { SHORT_WALLET_REFUSAL } from "./fixtures/treasury";

/**
 * A payment refused for a short wallet while Treasury holds money, as the
 * Bills page shows it: the API's message and "Move to wallet", which opens
 * the sheet prefilled with the suggested amount.
 */
export function TreasuryShortPreview(): JSX.Element {
  return (
    <section>
      <PageHeader
        title="Bills"
        subtitle="The refusal a payment gets when the wallet is short and Treasury holds money."
      />
      <Banners>
        <Banner
          role="alert"
          tone="warn"
          title={describePaymentError(SHORT_WALLET_REFUSAL)}
          actions={
            <>
              <TreasuryOfferButton error={SHORT_WALLET_REFUSAL} />
              <Button variant="outline" size="md">
                Done
              </Button>
            </>
          }
        />
      </Banners>
    </section>
  );
}
