import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  sampleInvoice,
  seedInvoices,
} from "~/app/dev/preview/_harness/fixtures/invoices";
import { MarkPaidForm, VoidInvoiceForm } from "./invoice-action-forms";
import { InvoiceForm } from "./invoice-form";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T09:00:00+03:00"));
});
afterAll(() => {
  vi.useRealTimers();
});

function render(node: React.ReactNode): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  seedInvoices(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const DRAFT = sampleInvoice("INV-0005");
const OPEN = sampleInvoice("INV-0004");

describe("the new invoice form", () => {
  it("starts with the suggested number, today, net 30, a blank line and VAT as the tax name", () => {
    // #when
    const html = render(
      <InvoiceForm
        organizationId={ORG}
        invoice={null}
        footerSlot={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const text = textOf(html);

    // #then
    expect({
      number: html.includes('value="INV-0006"'),
      issueOn: html.includes('value="2026-11-06"'),
      netThirty:
        /<option[^>]*value="net_30"[^>]*selected/.test(html) ||
        /<option[^>]*selected[^>]*value="net_30"/.test(html),
      dueOn: text.includes("6 Dec 2026"),
      terms: ["On receipt", "Net 15", "Net 30", "Custom date"].every((label) =>
        text.includes(label),
      ),
      customers: ["Acme Freight Ltd", "Savanna Foods", "Lakeview Hotels"].every(
        (name) => text.includes(name),
      ),
      archivedHidden: !text.includes("Old Mombasa Traders"),
      taxName: html.includes('value="VAT"'),
      addCustomer: text.includes("Add a new customer"),
      totals:
        text.includes("Subtotal USD 0.00") && text.includes("Total USD 0.00"),
      buttons: ["Save and send", "Save draft", "Cancel"].every((label) =>
        text.includes(label),
      ),
    }).toEqual({
      number: true,
      issueOn: true,
      netThirty: true,
      dueOn: true,
      terms: true,
      customers: true,
      archivedHidden: true,
      taxName: true,
      addCustomer: true,
      totals: true,
      buttons: true,
    });
  });
});

describe("editing a draft", () => {
  it("fills the form from the draft, with the line's amount and totals worked out", () => {
    // #when
    const html = render(
      <InvoiceForm
        organizationId={ORG}
        invoice={DRAFT}
        footerSlot={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const text = textOf(html);

    // #then
    expect({
      number: html.includes('value="INV-0005"'),
      description: html.includes('value="November dispatch software"'),
      price: html.includes('value="850.00"'),
      amount: text.includes("USD 850.00"),
      total: text.includes("Total USD 850.00"),
      form: html.includes('aria-label="Edit invoice"'),
    }).toEqual({
      number: true,
      description: true,
      price: true,
      amount: true,
      total: true,
      form: true,
    });
  });

  it("shows tax from the saved rate", () => {
    // #when
    const html = render(
      <InvoiceForm
        organizationId={ORG}
        invoice={{ ...OPEN, status: "draft" }}
        footerSlot={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const text = textOf(html);

    // #then
    expect({
      rate: html.includes('value="16"'),
      lines: text.includes("USD 1,500.00") && text.includes("USD 900.00"),
      tax: text.includes("VAT (16%) USD 384.00"),
      total: text.includes("Total USD 2,784.00"),
    }).toEqual({ rate: true, lines: true, tax: true, total: true });
  });
});

describe("the settle forms", () => {
  it("warns that voiding can't be undone and asks for a reason", () => {
    // #when
    const text = textOf(
      render(
        <VoidInvoiceForm
          organizationId={ORG}
          invoice={OPEN}
          footerSlot={null}
          onDone={vi.fn()}
        />,
      ),
    );

    // #then
    expect({
      warning: text.includes("Voiding can't be undone."),
      reason: text.includes("Why are you voiding it?"),
      confirm: text.includes("Void invoice"),
    }).toEqual({ warning: true, reason: true, confirm: true });
  });

  it("asks for the date paid, defaulting to today, a reference and a note", () => {
    // #when
    const html = render(
      <MarkPaidForm
        organizationId={ORG}
        invoice={OPEN}
        footerSlot={null}
        onDone={vi.fn()}
      />,
    );
    const text = textOf(html);

    // #then
    expect({
      today: html.includes('value="2026-11-06"'),
      max: html.includes('max="2026-11-06"'),
      labels: ["Date paid", "Reference (optional)", "Note (optional)"].every(
        (label) => text.includes(label),
      ),
      confirm: text.includes("Mark as paid"),
    }).toEqual({ today: true, max: true, labels: true, confirm: true });
  });
});
