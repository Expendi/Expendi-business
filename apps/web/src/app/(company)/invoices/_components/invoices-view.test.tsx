import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CUSTOMERS,
  INVOICES,
  seedInvoices,
} from "~/app/dev/preview/_harness/fixtures/invoices";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { InvoicesView } from "./invoices-view";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/invoices",
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

function idOf(number: string): string {
  return INVOICES.find((invoice) => invoice.number === number)?.id ?? "";
}

function render(role: "admin" | "accountant", query = ""): string {
  navigation.params = new URLSearchParams(query);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  seedInvoices(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Mwangaza Logistics", role }}
      >
        <InvoicesView />
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

const sheetOf = (html: string) =>
  textOf(html.slice(html.indexOf("data-sheet")));

describe("the invoices page", () => {
  it("lists every invoice with its customer, status, a red Overdue on the late open one, and the total in dollars", () => {
    // #when
    const text = textOf(render("admin"));

    // #then
    expect({
      title: text.includes("Invoices Bill customers in US dollars"),
      tabs: text.includes("Invoices Customers"),
      newInvoice: text.includes("New invoice"),
      lateOne: text.includes("INV-0004 Acme Freight Ltd"),
      overdue: text.includes("Open Overdue"),
      total: text.includes("USD 2,784.00"),
      paid: text.includes("INV-0002 Acme Freight Ltd"),
      draft: text.includes("Draft"),
      void: text.includes("Void"),
      notSent: text.includes("Not sent"),
    }).toEqual({
      title: true,
      tabs: true,
      newInvoice: true,
      lateOne: true,
      overdue: true,
      total: true,
      paid: true,
      draft: true,
      void: true,
      notSent: true,
    });
  });

  it("gives an accountant the same list with no New invoice", () => {
    // #when
    const text = textOf(render("accountant"));

    // #then
    expect({
      rows: text.includes("INV-0004 Acme Freight Ltd"),
      newInvoice: text.includes("New invoice"),
      note: text.includes("Only admins create, send and change them."),
    }).toEqual({ rows: true, newInvoice: false, note: true });
  });

  it("shows the status filter chip, set from the URL", () => {
    // #when
    const text = textOf(render("admin", "status=overdue"));

    // #then
    expect(text).toContain("Status: Overdue");
  });
});

describe("an invoice's side sheet", () => {
  it("shows an overdue open invoice: parties, lines, tax, totals and the open actions", () => {
    // #when
    const text = sheetOf(render("admin", `invoice=${idOf("INV-0004")}`));

    // #then
    expect({
      header: text.includes("INV-0004") && text.includes("USD 2,784.00"),
      badges: text.includes("Open Overdue"),
      billTo: text.includes(
        "Bill to Acme Freight Ltd accounts@acmefreight.co.ke",
      ),
      from: text.includes("From Mwangaza Logistics KRA PIN P051122334Q"),
      line: text.includes("Route optimisation audit USD 1,500.00"),
      quantity: text.includes("12.5 × USD 120.00"),
      subtotal: text.includes("Subtotal USD 2,400.00"),
      tax: text.includes("VAT (16%) USD 384.00"),
      total: text.includes("Total USD 2,784.00"),
      note: text.includes("Pay in USDC from the link. Thank you."),
      actions: [
        "Mark paid",
        "Copy pay link",
        "Remind",
        "Match a deposit",
        "Void",
      ].every((label) => text.includes(label)),
      noDraftActions: !text.includes("Send") && !text.includes("Delete"),
    }).toEqual({
      header: true,
      badges: true,
      billTo: true,
      from: true,
      line: true,
      quantity: true,
      subtotal: true,
      tax: true,
      total: true,
      note: true,
      actions: true,
      noDraftActions: true,
    });
  });

  it("links a sent invoice's PDF, open, paid or void, and a draft has none", () => {
    // #when
    const linked = ["INV-0004", "INV-0002", "INV-0000", "INV-0005"].map(
      (number) =>
        /href="\/pay\/sample-pay-link-\d+\/pdf"/.test(
          render("admin", `invoice=${idOf(number)}`),
        ),
    );

    // #then
    expect(linked).toEqual([true, true, true, false]);
  });

  it("gives an accountant the PDF link too", () => {
    // #when
    const text = sheetOf(render("accountant", `invoice=${idOf("INV-0001")}`));

    // #then
    expect(text).toContain("Download PDF");
  });

  it("offers a draft Send, Edit and Delete, and no pay link", () => {
    // #when
    const text = sheetOf(render("admin", `invoice=${idOf("INV-0005")}`));

    // #then
    expect({
      send: text.includes("Send"),
      edit: text.includes("Edit"),
      del: text.includes("Delete"),
      noLink: !text.includes("Copy pay link"),
      noMarkPaid: !text.includes("Mark paid"),
    }).toEqual({
      send: true,
      edit: true,
      del: true,
      noLink: true,
      noMarkPaid: true,
    });
  });

  it("lists a link payment with its chain, hash and USDC, which can't be undone, beside only the pay link", () => {
    // #when
    const text = sheetOf(render("admin", `invoice=${idOf("INV-0002")}`));

    // #then
    expect({
      payment: text.includes(
        "Paid through link 9 Oct 2026 · Base · 0x4f2a9c…7d6c5b",
      ),
      usdc: text.includes("2,400.00 USDC"),
      noUndo: !text.includes("Undo this payment"),
      copy: text.includes("Copy pay link"),
      noRemind: !text.includes("Remind"),
    }).toEqual({
      payment: true,
      usdc: true,
      noUndo: true,
      copy: true,
      noRemind: true,
    });
  });

  it("lets an admin undo a payment marked outside Expendi, with its reference and note", () => {
    // #when
    const text = sheetOf(render("admin", `invoice=${idOf("INV-0001")}`));

    // #then
    expect({
      payment: text.includes(
        "Marked paid 25 Sep 2026 · KCB-88213 · Bank transfer",
      ),
      undo: text.includes("Undo this payment"),
    }).toEqual({ payment: true, undo: true });
  });

  it("gives an accountant the details and no action buttons", () => {
    // #when
    const text = sheetOf(render("accountant", `invoice=${idOf("INV-0001")}`));

    // #then
    expect({
      details: text.includes("Pilot programme"),
      note: text.includes("View only. Only admins change invoices."),
      actions: [
        "Mark paid",
        "Copy pay link",
        "Remind",
        "Void",
        "Undo",
        "Send",
      ].filter((label) => text.includes(label)),
    }).toEqual({ details: true, note: true, actions: [] });
  });

  it("shows why a void invoice was voided, with no actions", () => {
    // #when
    const text = sheetOf(render("admin", `invoice=${idOf("INV-0000")}`));

    // #then
    expect({
      reason: text.includes("Voided: Issued to the wrong entity"),
      actions: ["Mark paid", "Copy pay link", "Remind", "Send", "Edit"].filter(
        (label) => text.includes(label),
      ),
    }).toEqual({ reason: true, actions: [] });
  });
});

describe("the customers tab", () => {
  it("lists active customers with email and tax ID, and leaves archived ones out", () => {
    // #when
    const text = textOf(render("admin", "tab=customers"));

    // #then
    expect({
      acme: text.includes("Acme Freight Ltd accounts@acmefreight.co.ke"),
      taxId: text.includes("P051234567X"),
      newCustomer: text.includes("New customer"),
      archived: text.includes(CUSTOMERS[3]?.name ?? "?"),
    }).toEqual({ acme: true, taxId: true, newCustomer: true, archived: false });
  });

  it("shows archived customers when the filter asks", () => {
    // #when
    const text = textOf(render("admin", "tab=customers&archived=archived"));

    // #then
    expect({
      archived: text.includes("Old Mombasa Traders"),
      active: text.includes("Savanna Foods"),
    }).toEqual({ archived: true, active: false });
  });

  it("opens a customer's edit form for an admin, with Archive", () => {
    // #when
    const html = render("admin", `tab=customers&customer=${CUSTOMERS[0]?.id}`);
    const text = sheetOf(html);

    // #then
    expect({
      form: html.includes('aria-label="Edit customer"'),
      archive: text.includes("Archive"),
    }).toEqual({ form: true, archive: true });
  });

  it("shows an accountant the customer's details with no form", () => {
    // #when
    const html = render(
      "accountant",
      `tab=customers&customer=${CUSTOMERS[0]?.id}`,
    );
    const text = sheetOf(html);

    // #then
    expect({
      form: html.includes('aria-label="Edit customer"'),
      details: text.includes("Tax ID P051234567X"),
      note: text.includes("View only. Only admins change customers."),
    }).toEqual({ form: false, details: true, note: true });
  });
});
