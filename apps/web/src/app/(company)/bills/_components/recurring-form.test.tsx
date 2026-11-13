import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ActiveWallet,
  RecurringItem,
  WalletResponse,
} from "@expendi-business/shared";

import { RECURRING_ITEMS } from "~/app/dev/preview/_harness/fixtures/bills";
import { billKeys } from "~/features/payment-keys";
import {
  blankDraft,
  draftFromItem,
} from "~/features/recurring/recurring-draft";
import { ApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { RecurringForm } from "./recurring-form";

vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const rent = RECURRING_ITEMS.find(
  (item) => item.payee.name === "Kilimani Properties",
);

function render(children: ReactNode, wallet?: WalletResponse): string {
  const client = new QueryClient();
  if (wallet) client.setQueryData(billKeys.kesRate(ORG), wallet);
  client.setQueryData(queryKeys.categories(ORG), [
    {
      id: rent?.category.id,
      name: "Rent & utilities",
      etimsNotRequired: false,
    },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the recurring payment form", () => {
  it("shows what's set once as text when editing, with only what can change as fields", () => {
    // #given
    if (!rent) throw new Error("The sample has Kilimani Properties' rent.");

    // #when
    const html = render(
      <RecurringForm
        organizationId={ORG}
        item={rent}
        initialDraft={draftFromItem(rent)}
        submitLabel="Save changes"
        submitting={false}
        submitError={null}
        footerSlot={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const text = textOf(html);

    // #then
    expect({
      note: text.includes(
        "Changes apply to the bills still to come. The overview heading follows the payee (Transactions) unless you pick another.",
      ),
      setOnce: text.includes(
        "Pay to Kilimani Properties When Monthly on the 1st Starts 1 Jan 2025 How it’s paid Through Expendi",
      ),
      payeeInput: text.includes("Choose a payee"),
      schedule: text.includes("How often"),
      start: text.includes("Start date"),
      amount: html.includes('value="48500.00"'),
      ends: html.includes('value="2027-12-31"'),
      category: text.includes("Rent & utilities"),
      saveDisabled: /<button[^>]*type="submit"[^>]*disabled=""/.test(html),
    }).toEqual({
      note: true,
      setOnce: true,
      payeeInput: false,
      schedule: false,
      start: false,
      amount: true,
      ends: true,
      category: true,
      saveDisabled: true,
    });
  });

  it("asks for the payee, schedule, start date and how it's paid on a new payment, and shows the first due date", () => {
    // #when
    const text = textOf(
      render(
        <RecurringForm
          organizationId={ORG}
          initialDraft={blankDraft("2026-11-06")}
          submitLabel="Set up payment"
          submitting={false}
          submitError={null}
          footerSlot={null}
          onSubmit={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );

    // #then
    expect(
      [
        "Its first bill is created now and shows in To pay.",
        "Pay to",
        "How often",
        "Start date",
        "Day of the month it’s due (1 to 31)",
        "Due: Monthly on the 6th",
        "First bill due 6 Nov 2026",
        "How it’s paid",
        "Remind admins (days before it’s due)",
        "Set up payment",
      ].filter((part) => !text.includes(part)),
    ).toEqual([]);
  });
});

const LIMITS: ActiveWallet = {
  status: "active",
  address: "company.near",
  chain: "near",
  usdcBalance: "0",
  kesEquivalent: null,
  cashOutLimits: { minKesCents: "2000", maxKesCents: "25000000" },
};

function editing(item: RecurringItem, submitError: unknown = null): string {
  return render(
    <RecurringForm
      organizationId={ORG}
      item={item}
      initialDraft={draftFromItem(item)}
      submitLabel="Save changes"
      submitting={false}
      submitError={submitError}
      footerSlot={null}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />,
    LIMITS,
  );
}

function itemTo(payee: string): RecurringItem {
  const found = RECURRING_ITEMS.find((item) => item.payee.name === payee);
  if (!found) throw new Error(`The samples pay ${payee}.`);
  return found;
}

describe("the recurring payment form's smallest amount", () => {
  it("shows only for a payment through Expendi to a payee paid by cash-out", () => {
    // #when
    const shown = [
      itemTo("Kilimani Properties"),
      itemTo("Figma"),
      itemTo("Hotpoint Appliances"),
      itemTo("CarMax Mechanics"),
    ].map((item) => editing(item).includes("Smallest amount: KES 20"));

    // #then
    expect(shown).toEqual([true, false, false, false]);
  });

  it("puts the API's refusal of the amount on the amount field, not under the form", () => {
    // #given
    const refused = new ApiError(
      400,
      "BadRequest",
      "The smallest amount that can be sent is KES 20.",
      { field: "amountKes" },
    );

    // #when
    const html = editing(itemTo("Kilimani Properties"), refused);

    // #then
    expect({
      onField:
        /aria-invalid="true"[^>]*value="48500.00"|value="48500.00"[^>]*aria-invalid="true"/.test(
          html,
        ),
      shown:
        textOf(html).split("The smallest amount that can be sent is KES 20.")
          .length - 1,
    }).toEqual({ onField: true, shown: 1 });
  });
});
