import type { JSX } from "react";

import type { AssetId } from "~/lib/assets";
import type { FooterLink, IconComponent, ImageLink } from "~/types/content";
import {
  AppleIcon,
  GooglePlayIcon,
  QontoWordmark,
  StarIcon,
  TrustpilotStarIcon,
} from "~/components/icons";
import { QontoImage } from "~/components/ui/qonto-image";
import { FOOTER_COLUMNS } from "~/content/navigation";
import { cn } from "~/lib/utils";
import { FooterRoot } from "./footer/footer-root";
import { LanguageSwitcher } from "./footer/language-switcher";
import { PricingCard } from "./footer/pricing-card";

/**
 * `.footer-link-underline` draws the hover line in `currentColor`; Qonto paints
 * it rgb(5, 5, 5) everywhere, so it stays invisible on the dark block.
 */
const UNDERLINE_LINK =
  "footer-link-underline bg-[linear-gradient(to_right,var(--color-primary-black)_0%,var(--color-primary-black)_100%)]";

interface Rating {
  store: string;
  icon: IconComponent;
}

const RATINGS: readonly Rating[] = [
  { store: "on App Store", icon: AppleIcon },
  { store: "on Play Store", icon: GooglePlayIcon },
  { store: "on Trustpilot", icon: TrustpilotStarIcon },
];

const BADGES: readonly { asset: AssetId; sizes: string }[] = [
  { asset: "33290", sizes: "64px" },
  { asset: "33292", sizes: "64px" },
  { asset: "33288", sizes: "112px" },
];

const SOCIAL_LINKS: readonly ImageLink[] = [
  {
    label: "Facebook",
    href: "https://www.facebook.com/getqonto",
    image: "33603",
  },
  { label: "X", href: "https://www.facebook.com/getqonto", image: "33596" },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/company/qonto",
    image: "33598",
  },
  {
    label: "Instagram",
    href: "https://www.instagram.com/qonto",
    image: "33599",
  },
  { label: "Medium", href: "https://medium.com/qonto-way", image: "33600" },
];

const STORE_LINKS: readonly (ImageLink & { sizes: string })[] = [
  {
    label: "App Store",
    href: "https://apps.apple.com/fr/app/qonto-business-finance-app/id1214811644?l=en-GB",
    image: "33597",
    sizes: "127px",
  },
  {
    label: "Play Store",
    href: "https://play.google.com/store/apps/details?id=eu.qonto.qonto&hl=en",
    image: "33601",
    sizes: "134px",
  },
];

const LEGAL_LINKS: readonly FooterLink[] = [
  { label: "Cookies", href: "https://qonto.com/en/cookies" },
  { label: "Legal Documents", href: "https://legal.qonto.com/en" },
  {
    label: "Privacy Policy",
    href: "https://legal.qonto.com/en#template-6uiwuhdde",
  },
  { label: "Security", href: "https://qonto.com/en/security" },
  {
    label: "AI at Qonto",
    href: "https://legal.qonto.com/#artificial-intelligence-at-qonto",
  },
  { label: "Status Page", href: "https://status.qonto.com/" },
];

const LEGAL_NOTICES: readonly string[] = [
  "Qonto SA is a Société Anonyme under French law, registered at the Paris Trade Register (n° 819 489 626) having its headquarters at 6 Impasse Bonne Nouvelle, 75010 Paris, France.",
  "Qonto SA is a licensed payment institution authorized by the French Autorité de Contrôle Prudentiel et de Résolution (ACPR), under the registration number 16958 granted on 21/06/2018.",
  "The entirety of the funds collected from our customers is safeguarded in compliance with the relevant legislation. A part of these funds is either held by our partner banks, Crédit Mutuel Arkéa, Société Générale, Natixis or Rothschild Martin Maurel, or invested in qualified money market funds, with the corresponding fund units held by Société Générale. In the case of bankruptcy of one of these partner banks, the deposits are covered up to €100,000 per institution and per client by the Fonds de Garantie des Dépôts et de Résolution (FGDR). The remaining part of the funds is fully covered by two stand-alone guarantees, one granted by Crédit Agricole CIB, a subsidiary of Crédit Agricole S.A., the other by BNP Paribas.",
];

/** One row of three below 1024px (number above label), a column from lg. */
function Ratings(): JSX.Element {
  return (
    <div className="my-32 flex justify-center gap-16 md:self-start lg:my-24 lg:flex-col lg:gap-24 lg:self-stretch lg:px-16">
      {RATINGS.map(({ store, icon: Icon }) => (
        <div key={store} className="lg:flex lg:items-center lg:gap-8">
          <div className="flex items-center justify-center gap-4 lg:justify-start lg:gap-8">
            <span className="h3-small">4.7</span>
            <StarIcon className="size-20" />
          </div>
          <div className="flex items-center gap-4">
            <Icon className="size-16" />
            <span className="caption-slim text-nowrap">{store}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function LinkColumns(): JSX.Element {
  return (
    <nav
      aria-label="Footer"
      className="col-span-12 columns-2 gap-x-24 md:columns-3 lg:col-span-9"
    >
      {FOOTER_COLUMNS.map(({ title, links }) => (
        <div key={title} className="mb-32 break-inside-avoid lg:mb-24">
          <p className="body-small-bold pb-16 lg:pb-8">{title}</p>
          <ul>
            {links.map(({ label, href }) => (
              <li key={label} className="caption pb-8 text-grey-300">
                <a href={href} className={UNDERLINE_LINK}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function BrandRow(): JSX.Element {
  return (
    <div className="flex flex-col justify-between gap-y-40 pb-40 md:gap-y-32 md:pb-32 lg:flex-row lg:items-end lg:py-40">
      <div className="flex justify-center md:justify-start">
        <QontoWordmark
          role="img"
          aria-label="Qonto"
          className="h-100 w-343 shrink-0 text-[#1d1d1b]"
        />
      </div>

      <div className="flex flex-col justify-between gap-y-32 md:flex-row lg:justify-start lg:gap-x-16">
        <div className="flex items-end justify-center gap-8">
          {BADGES.map(({ asset, sizes }) => (
            <QontoImage
              key={asset}
              asset={asset}
              alt="Badge Asset"
              sizes={sizes}
              className="h-64 w-auto"
            />
          ))}
        </div>

        <div className="flex flex-col gap-y-32 md:gap-y-16 lg:gap-y-24">
          <div className="flex justify-center md:justify-end">
            {SOCIAL_LINKS.map(({ label, href, image }) => (
              <div key={label} className="px-6">
                <a href={href} className="block">
                  <QontoImage
                    asset={image}
                    alt={label}
                    className="h-30 w-auto"
                  />
                </a>
              </div>
            ))}
          </div>
          <div className="flex justify-center gap-16 md:justify-end">
            {STORE_LINKS.map(({ label, href, image, sizes }) => (
              <a key={label} href={href}>
                <QontoImage
                  asset={image}
                  alt={label}
                  sizes={sizes}
                  className="h-40 w-auto"
                />
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SiteFooter(): JSX.Element {
  return (
    <FooterRoot className="text-16 leading-24 md:text-18">
      <div
        data-header-theme="dark"
        className="darkmode relative z-1 bg-primary-black px-16 py-40 text-primary-white md:px-32 md:py-64 lg:px-48 lg:py-80"
      >
        <div className="mx-auto grid max-w-1504 grid-cols-12 gap-x-8 md:gap-x-24">
          <div className="col-span-12 flex flex-col lg:col-span-3">
            <PricingCard />
            <Ratings />
          </div>
          <LinkColumns />
        </div>
      </div>

      <div
        data-header-theme="light"
        className="relative z-10 bg-primary-white px-16 pt-40 text-primary-black md:px-32 md:pt-64 lg:px-48 lg:pt-40"
      >
        <BrandRow />

        <hr className="w-full border-t border-grey-300" />

        <div className="flex items-center justify-between">
          <div className="caption-small mt-24 md:mb-16 lg:mt-32">
            {LEGAL_LINKS.map(({ label, href }) => (
              <a
                key={label}
                href={href}
                className={cn(UNDERLINE_LINK, "mr-16 pt-6 md:pt-0")}
              >
                <span>{label}</span>{" "}
              </a>
            ))}
          </div>
          <div className="hidden pt-8 md:block">
            <LanguageSwitcher align="end" className="py-16 pl-40 lg:pt-24" />
          </div>
        </div>
        <div className="md:hidden">
          <LanguageSwitcher align="center" className="py-16" />
        </div>

        <div className="caption-small flex flex-col gap-18 pb-40 md:pb-64 lg:pb-80">
          {LEGAL_NOTICES.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      </div>
    </FooterRoot>
  );
}
