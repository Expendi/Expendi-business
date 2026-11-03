import type { JSX } from "react";

import { Bento } from "~/components/sections/bento";
import { ClosingCta } from "~/components/sections/closing-cta";
import { CreateCompany } from "~/components/sections/create-company";
import { Hero } from "~/components/sections/hero";
import { Integrations } from "~/components/sections/integrations";
import { InvoicingCards } from "~/components/sections/invoicing-cards";
import { Protection } from "~/components/sections/protection";
import { QontoAi } from "~/components/sections/qonto-ai";
import { Testimonials } from "~/components/sections/testimonials";
import { TrustItems } from "~/components/sections/trust-items";

export default function HomePage(): JSX.Element {
  return (
    <main id="website-main">
      <Hero />
      <TrustItems />
      <Bento />
      <QontoAi />
      <InvoicingCards />
      <Integrations />
      <CreateCompany />
      <Testimonials />
      <Protection />
      <ClosingCta />
    </main>
  );
}
