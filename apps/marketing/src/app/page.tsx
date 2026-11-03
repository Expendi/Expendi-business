import type { JSX } from "react";

import { ChatbotLauncher } from "~/components/layout/chatbot-launcher";
import { CookieBanner } from "~/components/layout/cookie-banner";
import { MobileCtaBar } from "~/components/layout/mobile-cta-bar";
import { SiteFooter } from "~/components/layout/site-footer";
import { SiteHeader } from "~/components/layout/site-header";
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
    <>
      <SiteHeader />
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
      <MobileCtaBar />
      <SiteFooter />
      <ChatbotLauncher />
      <CookieBanner />
    </>
  );
}
