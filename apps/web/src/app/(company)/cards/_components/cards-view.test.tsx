import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  CardList,
  CardLoadList,
  CardProgram,
  CardPurchase,
  CardPurchaseList,
  CategoriesResponse,
  ExpendiCard,
  MembersResponse,
} from "@expendi-business/shared";

import type * as DetailSheetModule from "~/components/data/detail-sheet";
import type { PasskeyState } from "~/features/payment-ui";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { CardsView } from "./cards-view";
import { IssueCardSheet } from "./issue-card-sheet";
import { LoadSheet } from "./load-sheet";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/cards",
  useSearchParams: () => navigation.params,
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
}));
vi.mock("~/components/data/detail-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof DetailSheetModule>();
  return {
    ...actual,
    DetailSheet: ({
      open,
      eyebrow,
      title,
      headerExtra,
      footer,
      children,
    }: ComponentProps<typeof actual.DetailSheet>) =>
      open ? (
        <aside data-sheet="">
          <p>{eyebrow}</p>
          <h2>{title}</h2>
          {headerExtra}
          <div>{children}</div>
          <footer>{footer}</footer>
        </aside>
      ) : null,
  };
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const on = (
  overrides: Partial<Extract<CardProgram, { status: "on" }>> = {},
): CardProgram => ({
  status: "on",
  legalName: "Acme Ltd",
  balance: {
    loadedUsdCents: "500000",
    spentUsdCents: "180000",
    refundedUsdCents: "2500",
    onHoldUsdCents: "12999",
    availableUsdCents: "309501",
  },
  lowBalance: false,
  paused: false,
  turnedOnAt: "2026-10-20T07:00:00.000Z",
  ...overrides,
});

const holder = {
  membershipId: id(90),
  name: "Jane Wanjiku",
  email: "jane@example.com",
};
const category = { id: id(91), name: "Software" };

const card = (overrides: Partial<ExpendiCard> = {}): ExpendiCard => ({
  id: id(1),
  nickname: "Marketing subscriptions",
  lastFour: "0001",
  state: "open",
  monthlyLimitUsdCents: "150000",
  spentThisMonthUsdCents: "61200",
  holder,
  yours: false,
  defaultCategory: category,
  issuedAt: "2026-10-21T08:30:00.000Z",
  closedAt: null,
  ...overrides,
});

const purchase = (overrides: Partial<CardPurchase> = {}): CardPurchase => ({
  id: id(20),
  kind: "purchase",
  status: "settled",
  card: { id: id(1), nickname: "Marketing subscriptions", lastFour: "0001" },
  holder,
  yours: false,
  merchant: "Canva",
  mcc: "5734",
  holdUsdCents: "0",
  settledUsdCents: "4500",
  amountKes: "580500",
  usdKesRate: "129",
  authorizedAt: "2026-11-05T08:12:00.000Z",
  declineReason: null,
  expenseId: id(50),
  category,
  receiptCount: 0,
  noReceiptReason: null,
  needsReceipt: true,
  changedAfterExpense: false,
  ...overrides,
});

const refund = purchase({
  id: id(21),
  kind: "refund",
  merchant: "Notion",
  settledUsdCents: "2500",
  amountKes: null,
  usdKesRate: null,
  expenseId: null,
  needsReceipt: false,
});

interface Setup {
  role?: "admin" | "accountant";
  url?: string;
  program?: CardProgram | "error" | "loading";
  cards?: readonly ExpendiCard[];
  purchases?: readonly CardPurchase[];
  loads?: CardLoadList["loads"];
  enrolled?: boolean;
}

const NO_FILTERS = {
  cardId: null,
  status: null,
  needsReceipt: null,
} as const;

function render({
  role = "admin",
  url = "",
  program = on(),
  cards = [card()],
  purchases = [purchase(), refund],
  loads = [],
  enrolled = true,
}: Setup = {}): string {
  navigation.params = new URLSearchParams(url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  if (program === "error") {
    client
      .getQueryCache()
      .build(client, { queryKey: queryKeys.cardProgram(ORG) })
      .setState({ status: "error", error: new Error("Network down") });
  } else if (program !== "loading") {
    client.setQueryData(queryKeys.cardProgram(ORG), program);
  }
  const list: CardList = { cards: [...cards] };
  const loadList: CardLoadList = { loads };
  const page: CardPurchaseList = {
    purchases: [...purchases],
    nextCursor: null,
  };
  client.setQueryData(queryKeys.cardList(ORG), list);
  client.setQueryData(queryKeys.cardLoads(ORG), loadList);
  client.setQueryData(queryKeys.cardPurchases(ORG, NO_FILTERS), {
    pages: [page],
    pageParams: [null],
  });
  client.setQueryData(queryKeys.approvalPasskey, {
    enrolled,
    enrolledAt: enrolled ? "2026-10-01T09:00:00.000Z" : null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <CardsView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const sheetOf = (html: string) =>
  /<aside data-sheet="">.*<\/aside>/s.exec(html)?.[0] ?? "";

const BUTTONS = [
  "Load",
  "Issue card",
  "Freeze",
  "Unfreeze with passkey",
  "Change limit",
  "Close card",
  "No receipt",
];

const buttonsIn = (html: string) =>
  BUTTONS.filter((label) => new RegExp(`>${label}</button>`).test(html));

describe("Cards when they're off", () => {
  const off: CardProgram = { status: "off" };

  it("gives an admin the Turn on cards form with every field", () => {
    // #when
    const html = render({ program: off });
    const page = text(html);

    // #then
    expect({
      fields: [
        "legalName",
        "kraPin",
        "addressLine1",
        "city",
        "postalCode",
        "phone",
        "contactFirstName",
        "contactLastName",
        "contactEmail",
        "contactPhone",
      ].filter((name) => html.includes(`name="${name}"`)).length,
      submit: html.includes(">Turn on cards</button>"),
      sandbox: page.includes("Sandbox: no real money moves"),
    }).toEqual({ fields: 10, submit: true, sandbox: true });
  });

  it("tells an accountant cards aren't on, with no form", () => {
    // #when
    const html = render({ role: "accountant", program: off });
    const page = text(html);

    // #then
    expect({
      off: page.includes("Cards aren't on yet"),
      form: html.includes('name="legalName"'),
      submit: html.includes(">Turn on cards</button>"),
    }).toEqual({ off: true, form: false, submit: false });
  });

  it("shows a loading state and an error with Try again", () => {
    // #when
    const loading = render({ program: "loading" });
    const failed = text(render({ program: "error" }));

    // #then
    expect({
      busy: loading.includes('aria-busy="true"'),
      error: failed.includes("Cards didn't load"),
      retry: failed.includes("Try again"),
    }).toEqual({ busy: true, error: true, retry: true });
  });
});

describe("the Card balance", () => {
  it("shows available, on hold and loaded in USD, and that it's a sandbox", () => {
    // #when
    const page = text(render());

    // #then
    expect({
      sandbox: page.includes("Sandbox: no real money moves"),
      available: page.includes("Available USD 3,095.01"),
      hold: page.includes("On hold USD 129.99"),
      loaded: page.includes("Loaded USD 5,000.00"),
      spent: page.includes("USD 1,800.00 spent"),
    }).toEqual({
      sandbox: true,
      available: true,
      hold: true,
      loaded: true,
      spent: true,
    });
  });

  it("warns when the balance is low and offers a Load to admins", () => {
    // #when
    const admin = render({ program: on({ lowBalance: true }) });
    const accountant = render({
      role: "accountant",
      program: on({ lowBalance: true }),
    });

    // #then
    expect({
      adminWarned: text(admin).includes("The Card balance is low"),
      underFifty: text(admin).includes("Less than USD 50.00 is available"),
      accountantWarned: text(accountant).includes("The Card balance is low"),
      accountantButtons: buttonsIn(accountant),
    }).toEqual({
      adminWarned: true,
      underFifty: true,
      accountantWarned: true,
      accountantButtons: [],
    });
  });

  it("shows a balance below zero after a late clearing", () => {
    // #when
    const page = text(
      render({
        program: on({
          balance: {
            loadedUsdCents: "1000",
            spentUsdCents: "2500",
            refundedUsdCents: "0",
            onHoldUsdCents: "0",
            availableUsdCents: "-1500",
          },
        }),
      }),
    );

    // #then
    expect(page.includes("Available − USD 15.00")).toBe(true);
  });

  it("says when loads and new cards are paused and disables both", () => {
    // #when
    const html = render({ program: on({ paused: true }) });

    // #then
    expect({
      banner: text(html).includes("Card loads and new cards are paused"),
      loadDisabled: /<button[^>]*disabled=""[^>]*>[^]*?Load<\/button>/.test(
        html,
      ),
      issueDisabled: /disabled=""[^>]*>[^<]*<svg[^]*?Issue card<\/button>/.test(
        html,
      ),
    }).toEqual({ banner: true, loadDisabled: true, issueDisabled: true });
  });
});

describe("the cards list", () => {
  it("shows the holder, name, last four, state, limit and spend", () => {
    // #when
    const page = text(render({ role: "accountant" }));

    // #then
    expect({
      nickname: page.includes("Marketing subscriptions"),
      masked: page.includes("•••• 0001"),
      holder: page.includes("Jane Wanjiku"),
      state: page.includes("Open"),
      spent: page.includes("USD 612.00"),
      limit: page.includes("USD 1,500.00"),
    }).toEqual({
      nickname: true,
      masked: true,
      holder: true,
      state: true,
      spent: true,
      limit: true,
    });
  });

  it("gives admins Load and Issue card, and accountants neither", () => {
    expect({
      admin: buttonsIn(render()),
      accountant: buttonsIn(render({ role: "accountant" })),
    }).toEqual({ admin: ["Load", "Issue card"], accountant: [] });
  });

  it("says when there are no cards yet", () => {
    // #when
    const admin = text(render({ cards: [] }));
    const accountant = text(render({ role: "accountant", cards: [] }));

    // #then
    expect({
      admin: admin.includes("No cards yet"),
      issue: admin.includes("Issue a virtual card"),
      accountant: accountant.includes("Cards an admin issues show here."),
    }).toEqual({ admin: true, issue: true, accountant: true });
  });
});

describe("a card's sheet", () => {
  it("offers an admin freeze, a limit change and close on an open card", () => {
    // #when
    const sheet = sheetOf(render({ url: `id=${id(1)}` }));

    // #then
    expect({
      lastFour: text(sheet).includes("•••• 0001"),
      limit: text(sheet).includes("USD 1,500.00"),
      buttons: buttonsIn(sheet),
    }).toEqual({
      lastFour: true,
      limit: true,
      buttons: ["Freeze", "Change limit", "Close card"],
    });
  });

  it("offers Unfreeze with passkey on a frozen card", () => {
    // #when
    const sheet = sheetOf(
      render({ url: `id=${id(1)}`, cards: [card({ state: "frozen" })] }),
    );

    // #then
    expect(buttonsIn(sheet)).toEqual([
      "Unfreeze with passkey",
      "Change limit",
      "Close card",
    ]);
  });

  it("asks for an approval passkey before unfreezing without one", () => {
    // #when
    const sheet = sheetOf(
      render({
        url: `id=${id(1)}`,
        cards: [card({ state: "frozen" })],
        enrolled: false,
      }),
    );

    // #then
    expect({
      callout: text(sheet).includes("Set up your approval passkey first"),
      disabled: /disabled=""[^>]*>[^]*?Unfreeze with passkey/.test(sheet),
    }).toEqual({ callout: true, disabled: true });
  });

  it("gives an admin nothing to do on a closed card", () => {
    // #when
    const sheet = sheetOf(
      render({
        url: `id=${id(1)}`,
        cards: [
          card({ state: "closed", closedAt: "2026-11-02T09:00:00.000Z" }),
        ],
      }),
    );

    // #then
    expect({
      closed: text(sheet).includes("2 Nov 2026"),
      buttons: buttonsIn(sheet),
    }).toEqual({ closed: true, buttons: [] });
  });

  it("shows an accountant the details read-only, last four only", () => {
    // #when
    const sheet = sheetOf(render({ role: "accountant", url: `id=${id(1)}` }));

    // #then
    expect({
      viewOnly: text(sheet).includes("View only. Only admins change cards."),
      position: text(sheet).includes("1 of 1"),
      buttons: buttonsIn(sheet),
    }).toEqual({ viewOnly: true, position: true, buttons: [] });
  });
});

describe("the purchases tab", () => {
  it("lists merchant, holder, card, amounts, status and flags", () => {
    // #when
    const page = text(
      render({
        url: "tab=purchases",
        purchases: [
          purchase({ changedAfterExpense: true }),
          purchase({
            id: id(22),
            merchant: "Slack",
            status: "pending",
            holdUsdCents: "12999",
            settledUsdCents: "0",
            amountKes: null,
            expenseId: null,
          }),
        ],
      }),
    );

    // #then
    expect({
      merchant: page.includes("Canva"),
      holder: page.includes("Jane Wanjiku"),
      card: page.includes("Marketing subscriptions •••• 0001"),
      usd: page.includes("USD 45.00"),
      kes: page.includes("KES 5,805"),
      status: page.includes("Settled"),
      needsReceipt: page.includes("Needs receipt"),
      changed: page.includes("Changed after recording"),
      held: page.includes("On hold"),
    }).toEqual({
      merchant: true,
      holder: true,
      card: true,
      usd: true,
      kes: true,
      status: true,
      needsReceipt: true,
      changed: true,
      held: true,
    });
  });

  it("makes a refund visibly different and says the books aren't adjusted", () => {
    // #when
    const html = render({ url: "tab=purchases" });
    const page = text(html);

    // #then
    expect({
      said: page.includes("Refund · the books aren't adjusted"),
      plus: page.includes("+ USD 25.00"),
      green: html.includes("text-success-700"),
    }).toEqual({ said: true, plus: true, green: true });
  });

  it("has filters for card, status and receipt", () => {
    // #when
    const html = render({ url: "tab=purchases" });

    // #then
    expect({
      card: html.includes('aria-label="Filter by card"'),
      status: html.includes('aria-label="Filter by status"'),
      receipt: html.includes('aria-label="Filter by receipt"'),
    }).toEqual({ card: true, status: true, receipt: true });
  });

  it("says when no purchase matches, or none exist", () => {
    // #when
    const empty = text(render({ url: "tab=purchases", purchases: [] }));

    // #then
    expect(empty.includes("No purchases yet")).toBe(true);
  });
});

describe("a purchase's sheet", () => {
  it("offers an admin No receipt on a recorded expense missing one", () => {
    // #when
    const sheet = sheetOf(render({ url: `tab=purchases&purchase=${id(20)}` }));

    // #then
    expect({
      needs: text(sheet).includes("Needs a receipt"),
      kes: text(sheet).includes("KES 5,805"),
      buttons: buttonsIn(sheet),
    }).toEqual({ needs: true, kes: true, buttons: ["No receipt"] });
  });

  it("doesn't offer it before the Card expense exists", () => {
    // #when
    const sheet = sheetOf(
      render({
        url: `tab=purchases&purchase=${id(20)}`,
        purchases: [purchase({ expenseId: null })],
      }),
    );

    // #then
    expect({
      says: text(sheet).includes("once it settles"),
      buttons: buttonsIn(sheet),
    }).toEqual({ says: true, buttons: [] });
  });

  it("explains a refund and offers no waiver", () => {
    // #when
    const sheet = sheetOf(render({ url: `tab=purchases&purchase=${id(21)}` }));

    // #then
    expect({
      books: text(sheet).includes("The books aren't adjusted."),
      back: text(sheet).includes("back in the Card balance"),
      buttons: buttonsIn(sheet),
    }).toEqual({ books: true, back: true, buttons: [] });
  });

  it("shows an accountant no waiver", () => {
    // #when
    const sheet = sheetOf(
      render({
        role: "accountant",
        url: `tab=purchases&purchase=${id(20)}`,
      }),
    );

    // #then
    expect({
      viewOnly: text(sheet).includes("View only. Only admins waive receipts."),
      buttons: buttonsIn(sheet),
    }).toEqual({ viewOnly: true, buttons: [] });
  });
});

describe("the loads tab", () => {
  it("lists each Card load with its KES and rate", () => {
    // #when
    const page = text(
      render({
        role: "accountant",
        url: "tab=loads",
        loads: [
          {
            id: id(60),
            amountUsdCents: "300000",
            amountKes: "38700000",
            usdKesRate: "129",
            simulated: true,
            loadedBy: "Jane Wanjiku",
            createdAt: "2026-11-01T07:00:00.000Z",
          },
        ],
      }),
    );

    // #then
    expect({
      usd: page.includes("USD 3,000.00"),
      kes: page.includes("KES 387,000"),
      rate: page.includes("At KES 129 per USD"),
      by: page.includes("Jane Wanjiku"),
      simulated: page.includes("Simulated"),
    }).toEqual({
      usd: true,
      kes: true,
      rate: true,
      by: true,
      simulated: true,
    });
  });

  it("says when nothing has been loaded", () => {
    expect(
      text(render({ url: "tab=loads" })).includes("No Card loads yet"),
    ).toBe(true);
  });
});

function renderSheet(
  sheet: "load" | "issue",
  {
    passkey = "ready",
    members = [],
    categories = [],
  }: {
    passkey?: PasskeyState;
    members?: MembersResponse;
    categories?: CategoriesResponse;
  } = {},
): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.members(ORG), members);
  client.setQueryData(queryKeys.categories(ORG), categories);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {sheet === "load" ? (
        <LoadSheet
          organizationId={ORG}
          passkey={passkey}
          availableUsdCents="309501"
          onClose={vi.fn()}
        />
      ) : (
        <IssueCardSheet
          organizationId={ORG}
          passkey={passkey}
          onClose={vi.fn()}
          onIssued={vi.fn()}
        />
      )}
    </QueryClientProvider>,
  );
}

describe("Load", () => {
  it("takes a USD amount and confirms with the passkey", () => {
    // #when
    const html = renderSheet("load");
    const page = text(html);

    // #then
    expect({
      field: page.includes("Amount (USD)"),
      available: page.includes("Available now: USD 3,095.01"),
      sandbox: page.includes("Sandbox: no real money moves"),
      passkey: html.includes("Load with passkey"),
      noAmountOnButton: !page.includes("Load USD"),
    }).toEqual({
      field: true,
      available: true,
      sandbox: true,
      passkey: true,
      noAmountOnButton: true,
    });
  });

  it("asks an admin without a passkey to set one up first", () => {
    // #when
    const html = renderSheet("load", { passkey: "missing" });

    // #then
    expect({
      callout: text(html).includes("Set up your approval passkey first"),
      form: html.includes("Amount (USD)"),
    }).toEqual({ callout: true, form: false });
  });
});

describe("Issue card", () => {
  const members: MembersResponse = [
    {
      id: id(70),
      name: "Jane Wanjiku",
      email: "jane@example.com",
      role: "employee",
      status: "active",
      invitedAt: null,
      payoutPhoneConfirmed: true,
    },
    {
      id: id(71),
      name: "Accountant Ann",
      email: "ann@example.com",
      role: "accountant",
      status: "active",
      invitedAt: null,
      payoutPhoneConfirmed: false,
    },
  ];
  const categories: CategoriesResponse = [
    { ...category, etimsNotRequired: false },
  ];

  it("offers eligible people and every required field", () => {
    // #when
    const html = renderSheet("issue", { members, categories });
    const page = text(html);

    // #then
    expect({
      holder: page.includes("Jane Wanjiku (Employee)"),
      accountant: page.includes("Accountant Ann"),
      name: page.includes("Card name"),
      limit: page.includes("Monthly limit (USD)"),
      category: page.includes("Default category"),
      passkey: html.includes("Issue with passkey"),
    }).toEqual({
      holder: true,
      accountant: false,
      name: true,
      limit: true,
      category: true,
      passkey: true,
    });
  });

  it("says when nobody can hold a card", () => {
    // #when
    const page = text(renderSheet("issue", { members: [], categories }));

    // #then
    expect(page.includes("No one can hold a card yet")).toBe(true);
  });
});
