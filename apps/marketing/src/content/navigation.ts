import type { Country, FooterColumn, NavMenu } from "~/types/content";
import {
  AustriaFlag,
  BelgiumFlag,
  FranceFlag,
  GermanyFlag,
  ItalyFlag,
  MenuAcceptPaymentsIcon,
  MenuAccountAggregationIcon,
  MenuAccountRemunerationIcon,
  MenuAgentsIcon,
  MenuAllOurCreditOffersIcon,
  MenuBookkeepingIcon,
  MenuCashFlowManagementIcon,
  MenuCompanyCreationIcon,
  MenuCustomerCaseStudiesIcon,
  MenuDebitDeferredDebitCardsIcon,
  MenuDepositShareCapitalIcon,
  MenuEInvoicingAltIcon,
  MenuEInvoicingIcon,
  MenuExploreAllFeaturesIcon,
  MenuGetPaidInPersonIcon,
  MenuGetPaidOnlineIcon,
  MenuIntegrationsIcon,
  MenuInternationalTransfersIcon,
  MenuMicroBusinessesIcon,
  MenuOnlineBusinessAccountIcon,
  MenuOverdraftIcon,
  MenuPayLaterIcon,
  MenuPaymentTerminalsIcon,
  MenuSelfEmployedIcon,
  MenuTeamExpenseManagementIcon,
  MenuTransfersAndDirectDebitsIcon,
  NetherlandsFlag,
  PortugalFlag,
  SpainFlag,
} from "~/components/icons";

/** Desktop mega-menu and mobile drawer content, verbatim from qonto.com/en. */
export const NAV_MENUS: readonly NavMenu[] = [
  {
    title: "Business account",
    columns: [
      [
        {
          category: "Account & cards",
          items: [
            {
              label: "Online business account",
              href: "https://qonto.com/en/open-an-account",
              icon: MenuOnlineBusinessAccountIcon,
            },
            {
              label: "Debit & deferred debit cards",
              href: "https://qonto.com/en/payment-methods/card",
              icon: MenuDebitDeferredDebitCardsIcon,
            },
            {
              label: "Account remuneration",
              href: "https://qonto.com/en/open-an-account/remunerated-professional-account",
              icon: MenuAccountRemunerationIcon,
            },
            {
              label: "Account aggregation",
              href: "https://qonto.com/en/integrations/banks",
              icon: MenuAccountAggregationIcon,
            },
          ],
        },
        {
          category: "Tools",
          items: [
            {
              label: "Bookkeeping",
              href: "https://qonto.com/en/accounting",
              icon: MenuBookkeepingIcon,
            },
            {
              label: "E-invoicing",
              href: "https://qonto.com/en/invoicing",
              icon: MenuEInvoicingIcon,
            },
          ],
        },
      ],
      [
        {
          category: "Incoming payments",
          items: [
            {
              label: "Accept payments",
              href: "https://qonto.com/en/get-paid",
              icon: MenuAcceptPaymentsIcon,
            },
            {
              label: "Get paid online",
              href: "https://qonto.com/en/get-paid/online",
              icon: MenuGetPaidOnlineIcon,
            },
            {
              label: "Get paid in-person",
              href: "https://qonto.com/en/get-paid/in-person",
              icon: MenuGetPaidInPersonIcon,
            },
            {
              label: "Payment terminals",
              href: "https://qonto.com/en/payment-methods/pos",
              icon: MenuPaymentTerminalsIcon,
            },
          ],
        },
        {
          category: "Outgoing payments",
          items: [
            {
              label: "Transfers and direct debits",
              href: "https://qonto.com/en/payment-methods#transfers",
              icon: MenuTransfersAndDirectDebitsIcon,
            },
            {
              label: "International transfers",
              href: "https://qonto.com/en/payment-methods/international-transfer",
              icon: MenuInternationalTransfersIcon,
            },
          ],
        },
      ],
      [
        {
          category: "Resources",
          items: [
            {
              label: "Our tools & guides",
              href: "https://qonto.com/en/resources",
            },
            {
              label: "Business account comparators",
              href: "https://qonto.com/en/comparators",
            },
            { label: "Blog", href: "https://qonto.com/en/blog/freelancers" },
            {
              label: "Discover Qonto AI",
              href: "https://qonto.com/en/ai-agent-hub",
            },
          ],
        },
      ],
    ],
    highlight: {
      title: "E-invoicing",
      description: "Qonto-certified platform to send and receive invoices.",
      href: "https://qonto.com/en/invoicing",
      image: "35257",
    },
  },
  {
    title: "Company creation",
    columns: [
      [
        {
          category: "Online business setup",
          items: [
            {
              label: "Company creation",
              href: "https://qonto.com/en/creation",
              icon: MenuCompanyCreationIcon,
            },
            {
              label: "Deposit share capital",
              href: "https://qonto.com/en/capital-deposit",
              icon: MenuDepositShareCapitalIcon,
            },
          ],
        },
      ],
      [
        {
          category: "Resources",
          items: [
            { label: "Our toolbox", href: "https://qonto.com/en/resources" },
            {
              label: "Chartered Accountants directory",
              href: "https://qonto.com/fr/accountants-partners",
            },
            { label: "Blog", href: "https://qonto.com/en/blog/creators" },
          ],
        },
      ],
    ],
    highlight: {
      title: "Business creation guide",
      description: "All the key steps to get you started.",
      href: "https://qonto.com/en/blog/creators/tools-tips/mistakes-starting-your-business",
      image: "33275",
    },
  },
  {
    title: "Financial tools",
    columns: [
      [
        {
          category: "Solutions",
          items: [
            {
              label: "Explore all features",
              href: "https://qonto.com/en/finance-management",
              icon: MenuExploreAllFeaturesIcon,
            },
            {
              label: "Team expense management",
              href: "https://qonto.com/en/team",
              icon: MenuTeamExpenseManagementIcon,
            },
            {
              label: "Payment cards",
              href: "https://qonto.com/en/payment-methods/card",
              icon: MenuDebitDeferredDebitCardsIcon,
            },
            {
              label: "E-invoicing",
              href: "https://qonto.com/en/invoicing",
              icon: MenuEInvoicingAltIcon,
            },
            {
              label: "Accounting & bookkeeping",
              href: "https://qonto.com/en/accounting",
              icon: MenuBookkeepingIcon,
            },
            {
              label: "Integrations",
              href: "https://qonto.com/en/integrations",
              icon: MenuIntegrationsIcon,
            },
            {
              label: "Cash flow management",
              href: "https://qonto.com/en/cash-management",
              icon: MenuCashFlowManagementIcon,
            },
          ],
        },
      ],
      [
        {
          category: "Resources",
          items: [
            {
              label: "Entrepreneur insight 2026",
              href: "https://qonto.com/en/resources/entrepreneur-survey",
            },
            {
              label: "Corporate expense policy template",
              href: "https://qonto.com/en/resources/template/expense-policy",
            },
            {
              label: "Cash flow management checklist",
              href: "https://qonto.com/docs/pdf/cash%20flow%20management%20checklist.pdf",
            },
            {
              label: "Discover Qonto AI",
              href: "https://qonto.com/en/ai-agent-hub",
            },
          ],
        },
      ],
    ],
    highlight: {
      title: "Explore our platform",
      description: "Discover how our financial tools work",
      href: "https://qonto.com/en/product-tour",
      image: "35031",
    },
  },
  {
    title: "Credit",
    columns: [
      [
        {
          category: "Solutions",
          items: [
            {
              label: "All our credit offers",
              href: "https://qonto.com/en/financing",
              icon: MenuAllOurCreditOffersIcon,
            },
            {
              label: "Deferred debit card",
              href: "https://qonto.com/en/payment-methods/card/credit-card",
              icon: MenuDebitDeferredDebitCardsIcon,
            },
            {
              label: "Overdraft",
              href: "https://qonto.com/en/financing/overdraft",
              icon: MenuOverdraftIcon,
            },
            {
              label: "Pay later",
              href: "https://qonto.com/en/financing/pay-later",
              icon: MenuPayLaterIcon,
            },
          ],
        },
      ],
      [
        {
          category: "Resources",
          items: [
            {
              label: "ROI calculator",
              href: "https://qonto.com/en/tools/roi-calculator",
            },
            {
              label: "Our tools & guides",
              href: "https://qonto.com/en/resources",
            },
            { label: "Blog", href: "https://qonto.com/en/blog/sme/growth" },
          ],
        },
      ],
    ],
    highlight: {
      title: "Managing business cash flow",
      description: "Why it matters and how to invest it.",
      href: "https://qonto.com/en/cash-management",
      image: "35042",
    },
  },
  {
    title: "Pricing",
    columns: [
      [
        {
          category: "Business account pricing",
          items: [
            {
              label: "Self-employed",
              href: "https://qonto.com/en/pricing?select-toggle=solo&periodicity=yearly&website_addon_period=yearly",
              icon: MenuSelfEmployedIcon,
            },
            {
              label: "Micro-businesses",
              href: "https://qonto.com/en/pricing?select-toggle=team&periodicity=yearly&website_addon_period=yearly",
              icon: MenuMicroBusinessesIcon,
            },
            {
              label: "SMEs",
              href: "https://qonto.com/en/pricing?select-toggle=team&periodicity=yearly&website_addon_period=yearly",
              icon: MenuMicroBusinessesIcon,
            },
          ],
        },
      ],
      [
        {
          category: "Company creation pricing",
          items: [
            {
              label: "Create a business",
              href: "https://qonto.com/en/pricing/creation",
              icon: MenuCompanyCreationIcon,
            },
            {
              label: "Capital deposit",
              href: "https://qonto.com/en/capital-deposit",
              icon: MenuDepositShareCapitalIcon,
            },
          ],
        },
      ],
    ],
  },
  {
    title: "About us",
    columns: [
      [
        {
          category: "About Qonto",
          items: [
            {
              label: "Customer case studies",
              href: "https://qonto.com/en/customers",
              icon: MenuCustomerCaseStudiesIcon,
            },
            {
              label: "About us",
              href: "https://qonto.com/en/about",
              icon: MenuOnlineBusinessAccountIcon,
            },
          ],
        },
        {
          category: "Qonto AI",
          items: [
            {
              label: "Agents",
              href: "https://qonto.com/en/ai",
              icon: MenuAgentsIcon,
            },
            {
              label: "MCP",
              href: "https://qonto.com/en/ai/mcp",
              icon: MenuIntegrationsIcon,
            },
          ],
        },
      ],
    ],
    highlight: {
      title: "Discover Qonto AI",
      description: "Your Qonto account comes with built-in AI agents.\u00a0",
      href: "https://qonto.com/en/ai",
      image: "36901",
    },
  },
];

export const COUNTRIES: readonly Country[] = [
  { label: "France", href: "https://qonto.com/fr", flag: FranceFlag },
  { label: "Deutschland", href: "https://qonto.com/de", flag: GermanyFlag },
  { label: "Espa\u00f1a", href: "https://qonto.com/es", flag: SpainFlag },
  { label: "Italia", href: "https://qonto.com/it", flag: ItalyFlag },
  {
    label: "\u00d6sterreich",
    href: "https://qonto.com/de-at",
    flag: AustriaFlag,
  },
  { label: "Belgi\u00eb", href: "https://qonto.com/fr-be", flag: BelgiumFlag },
  { label: "Portugal", href: "https://qonto.com/pt", flag: PortugalFlag },
  { label: "Nederland", href: "https://qonto.com/nl", flag: NetherlandsFlag },
];

export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {
    title: "BUSINESS ACCOUNT",
    links: [
      {
        label: "Open Business Bank Account",
        href: "https://qonto.com/en/open-an-account",
      },
      {
        label: "Business Account for Freelancers",
        href: "https://qonto.com/en/open-an-account/freelancers",
      },
      {
        label: "Account Remuneration",
        href: "https://qonto.com/en/open-an-account/remunerated-professional-account",
      },
      {
        label: "Bank Account for Associations",
        href: "https://qonto.com/en/open-an-account/association",
      },
    ],
  },
  {
    title: "BUSINESS CARDS",
    links: [
      {
        label: "One Card",
        href: "https://qonto.com/en/payment-methods/card/card-one",
      },
      {
        label: "Virtual Card",
        href: "https://qonto.com/en/payment-methods/card/virtual-card",
      },
      {
        label: "Plus Card",
        href: "https://qonto.com/en/payment-methods/card/card-plus",
      },
      {
        label: "See all cards",
        href: "https://qonto.com/en/payment-methods/card",
      },
    ],
  },
  {
    title: "COMPANY CREATION",
    links: [
      { label: "Create a Company", href: "https://qonto.com/en/creation" },
      {
        label: "Capital Deposit",
        href: "https://qonto.com/en/capital-deposit",
      },
    ],
  },
  {
    title: "GET PAID",
    links: [
      {
        label: "POS Terminal",
        href: "https://qonto.com/en/payment-methods/pos",
      },
      {
        label: "Payment Links",
        href: "https://qonto.com/en/payment-methods/payment-links",
      },
      {
        label: "Tap-to-Pay iPhone",
        href: "https://qonto.com/en/payment-methods/tap-to-pay-iphone",
      },
      {
        label: "Tap-to-Pay Android",
        href: "https://qonto.com/en/payment-methods/tap-to-pay-android",
      },
    ],
  },
  {
    title: "FINANCING",
    links: [
      { label: "Business Financing", href: "https://qonto.com/en/financing" },
      { label: "Pay Later", href: "https://qonto.com/en/financing/pay-later" },
      { label: "Overdraft", href: "https://qonto.com/en/financing/overdraft" },
    ],
  },
  {
    title: "FINANCIAL TOOLS",
    links: [
      {
        label: "Expense Management Software",
        href: "https://qonto.com/en/team",
      },
      {
        label: "Pre-accounting Solution",
        href: "https://qonto.com/en/accounting",
      },
      { label: "Invoicing Tool", href: "https://qonto.com/en/invoicing" },
      {
        label: "Cash-flow Management",
        href: "https://qonto.com/en/cash-management",
      },
      { label: "Integrations", href: "https://qonto.com/en/integrations" },
      {
        label: "Quotes Management",
        href: "https://qonto.com/en/invoicing/quotes",
      },
    ],
  },
  {
    title: "RESOURCES",
    links: [
      { label: "Product Tour", href: "https://qonto.com/en/product-tour" },
      {
        label: "Banking Comparators",
        href: "https://qonto.com/en/comparators",
      },
      { label: "Financial Glossary", href: "https://qonto.com/en/glossary" },
      {
        label: "SWIFT/BIC Code Finder",
        href: "https://qonto.com/en/swift-codes",
      },
      { label: "Qonto Insights", href: "https://qonto.com/en/insights" },
      { label: "See all resources", href: "https://qonto.com/en/resources" },
    ],
  },
  {
    title: "COMPANY",
    links: [
      { label: "Our Story", href: "https://qonto.com/en/about" },
      { label: "Press", href: "https://qonto.com/en/press" },
      { label: "Our Customers", href: "https://qonto.com/en/trust" },
      {
        label: "Sustainability & Inclusion",
        href: "https://qonto.com/en/impact",
      },
      { label: "Careers", href: "https://qonto.com/en/careers" },
      { label: "Blog", href: "https://qonto.com/en/blog" },
      {
        label: "FAQ & Support",
        href: "https://support-fr.qonto.com/hc/en-us?_gl=1*1c8hd4*_gcl_gb*R0NMLjE3NzE0MDYxMDAuQ2xrS0NBaUFuY3ZNQmhBWEVra0F3cTlwSEV0MjVnMDloZG84NnFSa2MtbTBDMUZ1bzYyOHUyaVVlTnZQcjNBSV9zdzVWR0JkRDNuT2tBT19FOURzSVhTV19STHl2Qk92QnhTUnpHZWgxUU9iSmZLVFlDZ0lHZ0s1dlEuZDg3QUNQdkJtZjRCRU1LbjlvMEQuLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLg..*_gcl_au*MTU3NzQyNzgzLjE3NjQxNzA2NjYuNjEyMTk2NjgxLjE3NjQyNDM5MzEuMTc2NDI0MzkzMA..",
      },
      { label: "Recommend Qonto", href: "https://qonto.com/en/referral" },
      { label: "Ethics Charter", href: "https://qonto.com/en/ethics-charter" },
    ],
  },
  {
    title: "FOR DEVELOPERS",
    links: [
      { label: "Qonto Embed", href: "https://qonto.com/en/qonto-embed" },
      {
        label: "Qonto API",
        href: "https://docs.qonto.com/introduction/welcome",
      },
    ],
  },
];
