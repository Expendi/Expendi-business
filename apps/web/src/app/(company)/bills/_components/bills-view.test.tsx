import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  seedBills,
  summarizeSampleBills,
  WALLET,
} from "~/app/dev/preview/_harness/fixtures/bills";
import { DashboardProvider } from "~/contexts/dashboard-context";
import {
  historySettledFrom,
  NO_BILL_FILTERS,
} from "~/features/bills/bill-list";
import { billListKey, billsSummaryKey } from "~/features/bills/bills-api";
import { billKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { BillsView } from "./bills-view";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bills",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => navigation.params,
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/components/data/detail-sheet", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { createElement } = await import("react");
  return {
    ...actual,
    DetailSheet: (props: SheetProps) =>
      props.open
        ? createElement(
            "section",
            { "data-sheet": "" },
            props.eyebrow,
            createElement("h2", null, props.title),
            props.headerExtra,
            props.children,
            props.footer,
          )
        : null,
  };
});
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

/** The side sheet, drawn in place: Radix portals don't render on the server. */
interface SheetProps {
  open: boolean;
  eyebrow?: ReactNode;
  title: ReactNode;
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TODAY = "2026-11-06";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T09:00:00+03:00"));
});
afterAll(() => {
  vi.useRealTimers();
});

function render(
  role: "admin" | "accountant",
  {
    query = "",
    enrolled = true,
    seed = seedBills,
  }: {
    query?: string;
    enrolled?: boolean;
    seed?: (client: QueryClient) => void;
  } = {},
): string {
  navigation.params = new URLSearchParams(query);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  seed(client);
  client.setQueryData(billKeys.kesRate(ORG), WALLET);
  client.setQueryData(queryKeys.approvalPasskey, {
    enrolled,
    enrolledAt: enrolled ? "2026-10-01T09:00:00.000Z" : null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Mwangaza Logistics", role }}
      >
        <BillsView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const checkboxes = (html: string) =>
  (html.match(/type="checkbox"/g) ?? []).length;

/** The table, before the phone cards repeat the same rows. */
const tableOf = (html: string) =>
  html.slice(0, html.indexOf('aria-label="Bills"><li'));

describe("the bills page", () => {
  it("shows an admin what's owed: one KES total, the tabs with counts, the filters and the actions", () => {
    // #when
    const html = render("admin");
    const text = textOf(html);

    // #then
    expect({
      importLink: html.includes('href="/imports?kind=bill"'),
      recurring: text.includes("Recurring payments"),
      newBill: text.includes("New bill"),
      toPay: text.includes(
        "To pay ≈ KES 342,372 15 bills · 1 without an amount",
      ),
      overdue: text.includes("Overdue 3 KES 80,500"),
      dueToday: text.includes("Due today 2 ≈ KES 12,804"),
      failed: text.includes("Payment failed 1 KES 4,100"),
      tabs: ["To pay 15", "Being paid 1", "History 10"].every((tab) =>
        text.includes(tab),
      ),
      chips: [
        "Filter by status",
        "Filter by payee",
        "Filter by category",
        "Filter by heading",
        "Filter by paid by",
        "Filter by source",
      ].every((label) => html.includes(`aria-label="${label}"`)),
      plusUsd: text.includes("+ USD"),
      claim: /claim/i.test(text),
    }).toEqual({
      importLink: true,
      recurring: true,
      newBill: true,
      toPay: true,
      overdue: true,
      dueToday: true,
      failed: true,
      tabs: true,
      chips: true,
      plusUsd: false,
      claim: false,
    });
  });

  it("lists To pay by urgency with due hints and markers, and checkboxes only on bills that can be paid together", () => {
    // #when
    const html = render("admin");
    const text = textOf(html);
    const table = tableOf(html);
    const order = [
      "Zuku",
      "Securex Guards",
      "Kilimani Properties",
      "Figma",
      "Safaricom",
      "KRA",
    ].map((name) => table.indexOf(`>${name}</button>`));

    // #then
    expect({
      ordered: order.every(
        (at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)),
      ),
      hints: ["2 days late", "6 days late", "Today", "In 3 days"].every(
        (hint) => text.includes(hint),
      ),
      meta: text.includes("INV-2026-1101 · Rent & utilities"),
      recurringMarker: html.includes('title="Recurring"'),
      fileMarker: html.includes('title="1 file"'),
      usdInKes: text.includes("≈ KES 5,805 today"),
      toEnter: text.includes("To enter"),
      notSet: text.includes("Not set"),
      checkboxes: checkboxes(html),
      selectionBar: text.includes("Select bills to pay together."),
      selectAll: text.includes("Select all payable"),
      salaries: text.includes("Salaries"),
    }).toEqual({
      ordered: true,
      hints: true,
      meta: true,
      recurringMarker: true,
      fileMarker: true,
      usdInKes: true,
      toEnter: true,
      notSet: true,
      checkboxes: 18,
      selectionBar: true,
      selectAll: true,
      salaries: false,
    });
  });

  it("shows an accountant the same bills with no way to add or pay them", () => {
    // #when
    const html = render("accountant");
    const text = textOf(html);

    // #then
    expect({
      subtitle: text.includes("Only admins add and pay bills."),
      importLink: html.includes("/imports"),
      newBill: text.includes("New bill"),
      recurring: text.includes("Recurring payments"),
      checkboxes: checkboxes(html),
      selectionBar: text.includes("Select bills to pay together."),
      zuku: text.includes("Zuku"),
    }).toEqual({
      subtitle: true,
      importLink: false,
      newBill: false,
      recurring: true,
      checkboxes: 0,
      selectionBar: false,
      zuku: true,
    });
  });

  it("asks an admin without an approval passkey to set one up before paying", () => {
    // #when
    const html = render("admin", { enrolled: false });
    const text = textOf(html);

    // #then
    expect({
      banner: text.includes("Set up your approval passkey first"),
      checkboxes: checkboxes(html),
      newBill: text.includes("New bill"),
    }).toEqual({ banner: true, checkboxes: 0, newBill: true });
  });

  it("shows History newest first by the day each bill was settled", () => {
    // #when
    const html = render("admin", { query: "view=history" });
    const text = textOf(html);
    const table = tableOf(html);

    // #then
    expect({
      settledColumn: text.includes("Settled"),
      newestFirst:
        table.indexOf(">Kenya Power</button>") <
        table.indexOf(">Hotpoint Appliances</button>"),
      paidOutside: text.includes("Paid outside Expendi"),
      cancelled: text.includes("Cancelled"),
      checkboxes: checkboxes(html),
      hints: text.includes("days late"),
    }).toEqual({
      settledColumn: true,
      newestFirst: true,
      paidOutside: true,
      cancelled: true,
      checkboxes: 0,
      hints: false,
    });
  });

  it("leaves the status filter off Being paid", () => {
    // #when
    const html = render("admin", { query: "view=paying" });

    // #then
    expect({
      status: html.includes('aria-label="Filter by status"'),
      twiga: textOf(html).includes("Twiga Foods"),
      checkboxes: checkboxes(html),
    }).toEqual({ status: false, twiga: true, checkboxes: 0 });
  });

  it("says when no bill matches the filters, with Clear all", () => {
    // #when
    const html = render("admin", {
      query: "source=one_off&heading=subscriptions",
    });
    const text = textOf(html);

    // #then
    expect({
      empty: text.includes("No bills match these filters"),
      clearAll: (text.match(/Clear all/g) ?? []).length,
      sourceSet: html.includes('aria-label="Source: One-off. Change"'),
    }).toEqual({ empty: true, clearAll: 2, sourceSet: true });
  });

  it("offers Try again when the bills don't load", () => {
    // #given
    const failing = (client: QueryClient) => {
      client.setQueryData(
        billsSummaryKey(ORG, { settledFrom: historySettledFrom(TODAY) }),
        summarizeSampleBills({}),
      );
      const query = client.getQueryCache().build(client, {
        queryKey: billListKey(ORG, "open", NO_BILL_FILTERS, TODAY),
      });
      query.setState({
        ...query.state,
        status: "error",
        error: new Error("Couldn't reach Expendi Business."),
        errorUpdatedAt: Date.now(),
      });
    };

    // #when
    const text = textOf(render("admin", { seed: failing }));

    // #then
    expect({
      title: text.includes("Bills didn't load"),
      retry: text.includes("Try again"),
      stats: text.includes("342,372"),
    }).toEqual({ title: true, retry: true, stats: true });
  });
});

/** What the side sheet shows, as text. */
const sheetOf = (html: string) => {
  const at = html.indexOf("data-sheet");
  return at < 0 ? null : textOf(html.slice(at));
};

describe("the bills page's side sheet", () => {
  it("opens a linked bill with its schedule, files and every action an admin has", () => {
    // #when
    const sheet = sheetOf(render("admin", { query: `billId=${id(1)}` }));

    // #then
    expect(
      [
        "Recurring payment",
        "Kilimani Properties",
        "KES 48,500",
        "Overdue",
        "Monthly on the 1st See recurring payment",
        "Reference INV-2026-1101",
        "Rent plus service charge.",
        "Invoice Open",
        "Pay",
        "Edit bill",
        "Add invoice",
        "Mark paid outside",
        "Cancel bill",
      ].filter((part) => !sheet?.includes(part)),
    ).toEqual([]);
  });

  it("says why a failed payment failed and offers a retry, and asks for a variable bill's amount", () => {
    // #when
    const failed = sheetOf(render("admin", { query: `billId=${id(5)}` }));
    const variable = sheetOf(render("admin", { query: `billId=${id(7)}` }));

    // #then
    expect({
      reason: failed?.includes(
        "Payment failed The paybill didn't accept the account number.",
      ),
      retry: failed?.includes("Retry payment"),
      toEnter: variable?.includes("Enter the amount first."),
      enter: variable?.includes("Enter the amount"),
      pay: variable?.includes(" Pay "),
      paidOutside: variable?.includes("Mark paid outside"),
    }).toEqual({
      reason: true,
      retry: true,
      toEnter: true,
      enter: true,
      pay: false,
      paidOutside: false,
    });
  });

  it("shows an accountant the bill read-only, with its place in the list", () => {
    // #when
    const sheet = sheetOf(render("accountant", { query: `billId=${id(1)}` }));

    // #then
    expect({
      note: sheet?.includes("View only. Only admins add and pay bills."),
      position: sheet?.includes("3 of 15"),
      edit: sheet?.includes("Edit bill"),
    }).toEqual({ note: true, position: true, edit: false });
  });

  it("lists the recurring payments, active first, with their next bill or none", () => {
    // #when
    const sheet = sheetOf(render("admin", { query: "recurring=all" }));

    // #then
    expect({
      title: sheet?.includes(
        "Recurring payments Set up once. Each one's next bill is always ready in To pay.",
      ),
      first: sheet?.includes(
        "Securex Guards Monthly on the 31st, or the month’s last day · KES 32,000 31 Oct 2026 Overdue",
      ),
      weekly: sheet?.includes(
        "Every Thursday · Variable 5 Nov 2026 Being paid",
      ),
      paused: sheet?.includes("Jubilee Health Paused"),
      ended: sheet?.includes("Canva Ended"),
      noMore: sheet?.includes("No more bills"),
      salaries: sheet?.includes("Salar"),
      add: sheet?.includes("New recurring payment"),
    }).toEqual({
      title: true,
      first: true,
      weekly: true,
      paused: true,
      ended: true,
      noMore: true,
      salaries: false,
      add: true,
    });
  });

  it("opens one recurring payment with its next bill, schedule and actions", () => {
    // #when
    const active = sheetOf(render("admin", { query: `recurring=${id(301)}` }));
    const paused = sheetOf(render("admin", { query: `recurring=${id(311)}` }));
    const viewOnly = sheetOf(
      render("accountant", { query: `recurring=${id(301)}` }),
    );

    // #then
    expect({
      back: active?.includes("Back to recurring payments"),
      nextBill: active?.includes(
        "Next bill Due 1 Nov 2026 KES 48,500 Overdue Open bill",
      ),
      after: active?.includes("The bill after that Due 1 Dec 2026"),
      reminder: active?.includes("5 days before it’s due"),
      activeActions: ["Edit payment", "Pause", "End payment"].every((label) =>
        active?.includes(label),
      ),
      resume: paused?.includes("Resume"),
      viewOnly: viewOnly?.includes(
        "View only. Only admins set up and change recurring payments.",
      ),
      viewOnlyEdit: viewOnly?.includes("Edit payment"),
    }).toEqual({
      back: true,
      nextBill: true,
      after: true,
      reminder: true,
      activeActions: true,
      resume: true,
      viewOnly: true,
      viewOnlyEdit: false,
    });
  });

  it("opens the New bill form from ?new=1 for an admin only", () => {
    // #when
    const admin = sheetOf(render("admin", { query: "new=1" }));
    const accountant = sheetOf(render("accountant", { query: "new=1" }));

    // #then
    expect({
      form: ["New bill", "Pay to", "Variable amount", "Add bill"].every(
        (part) => admin?.includes(part),
      ),
      accountant,
    }).toEqual({ form: true, accountant: null });
  });
});

/** The side sheet's markup, for its links and buttons. */
const sheetHtmlOf = (html: string) => html.slice(html.indexOf("data-sheet"));

describe("bills a company-held card pays", () => {
  it("labels them Automatic with the card's last four in To pay, with no checkbox to pay them", () => {
    // #when
    const html = render("admin");
    const table = textOf(tableOf(html));

    // #then
    expect({
      automatic: table.includes("Automatic · card •••• 0004"),
      declined: table.includes("Card declined"),
      paidBy: table.includes("Company-held card •••• 0004"),
      estimate: table.includes("About USD 20.00"),
      noEstimate: table.includes("No estimate"),
      vercel: html.includes('aria-label="Select Vercel"'),
      notion: html.includes('aria-label="Select Notion"'),
      figma: html.includes('aria-label="Select Figma"'),
    }).toEqual({
      automatic: true,
      declined: true,
      paidBy: true,
      estimate: true,
      noEstimate: true,
      vercel: false,
      notion: false,
      figma: true,
    });
  });

  it("says an automatic bill is paid when the payee charges the card, with its estimate and no Pay", () => {
    // #when
    const html = sheetHtmlOf(render("admin", { query: `billId=${id(15)}` }));
    const sheet = textOf(html);

    // #then
    expect({
      missing: [
        "Estimate USD 20.00",
        "Upcoming Automatic · card •••• 0004",
        "Paid automatically It's paid when Vercel charges Software subscriptions (•••• 0004). Nobody has to pay it.",
        "Paid by Company-held card, Software subscriptions •••• 0004",
        "Edit bill",
        "Add invoice",
        "Mark paid outside",
        "Cancel bill",
      ].filter((part) => !sheet.includes(part)),
      pay: html.includes(">Pay</button>"),
    }).toEqual({ missing: [], pay: false });
  });

  it("says why the card declined a bill, when, and what to do, with the way to Cards", () => {
    // #when
    const html = sheetHtmlOf(render("admin", { query: `billId=${id(16)}` }));
    const sheet = textOf(html);

    // #then
    expect({
      missing: [
        "Card declined It's over the card's monthly limit.",
        "Software subscriptions (•••• 0004) declined Notion's Card purchase on 4 Nov 2026, 09:00. The bill stays owed.",
        "Load the Card balance, raise the card's limit or unfreeze it",
        "Go to Cards",
      ].filter((part) => !sheet.includes(part)),
      cards: html.includes(`href="/cards?id=${id(9304)}"`),
      pay: html.includes(">Pay</button>"),
    }).toEqual({ missing: [], cards: true, pay: false });
  });

  it("shows a bill paid by card in History with the card, the amount, the day and its Card purchase", () => {
    // #when
    const history = textOf(render("admin", { query: "view=history" }));
    const html = sheetHtmlOf(
      render("admin", { query: `view=history&billId=${id(30)}` }),
    );
    const sheet = textOf(html);

    // #then
    expect({
      listed: history.includes("Paid by card"),
      missing: [
        "USD 19.80 KES 2,554",
        "Paid by card",
        "Paid by Card •••• 0004, Software subscriptions See the Card purchase",
        "Paid on 20 Oct 2026",
        "Add invoice",
      ].filter((part) => !sheet.includes(part)),
      purchase: html.includes(
        `href="/cards?tab=purchases&amp;purchase=${id(9406)}"`,
      ),
      paidOutside: sheet.includes("Mark paid outside"),
      cancel: sheet.includes("Cancel bill"),
    }).toEqual({
      listed: true,
      missing: [],
      purchase: true,
      paidOutside: false,
      cancel: false,
    });
  });

  it("lists a card-paid recurring payment with its card's last four", () => {
    // #when
    const list = sheetOf(render("admin", { query: "recurring=all" }));

    // #then
    expect(
      [
        "Vercel Monthly on the 20th · USD 20.00 · Card •••• 0004",
        "Notion Monthly on the 4th · No estimate · Card •••• 0004",
      ].filter((part) => !list?.includes(part)),
    ).toEqual([]);
  });

  it("opens a card-paid recurring payment with its card, and its number for admins", () => {
    // #when
    const admin = sheetOf(render("admin", { query: `recurring=${id(315)}` }));

    // #then
    expect(
      [
        "Estimate USD 20.00",
        "Paid automatically when Vercel charges the card. Nobody has to pay each bill.",
        "How it’s paid By company-held card, Software subscriptions •••• 0004 See the card",
        "Reminder Only if a bill goes overdue",
        "Show card number",
      ].filter((part) => !admin?.includes(part)),
    ).toEqual([]);
  });

  it("badges a recurring payment's next bill Card declined, in the list and its detail", () => {
    // #when
    const list = sheetOf(render("admin", { query: "recurring=all" }));
    const notion = sheetOf(render("admin", { query: `recurring=${id(316)}` }));
    const vercel = sheetOf(render("admin", { query: `recurring=${id(315)}` }));

    // #then
    expect({
      list: list?.match(/Card declined/g)?.length,
      notionRow: list?.includes("Overdue Card declined"),
      notion: notion?.includes("Overdue Card declined"),
      vercel: vercel?.includes("Card declined"),
    }).toEqual({ list: 1, notionRow: true, notion: true, vercel: false });
  });

  it("shows an accountant a card-paid recurring payment without the card's number", () => {
    // #when
    const accountant = sheetOf(
      render("accountant", { query: `recurring=${id(315)}` }),
    );

    // #then
    expect({
      card: accountant?.includes("Software subscriptions •••• 0004"),
      number: accountant?.includes("Show card number"),
    }).toEqual({ card: true, number: false });
  });
});
