import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RecurringItem } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { recurringKeys } from "~/features/payment-keys";
import { draftFromItem } from "~/features/recurring/recurring-draft";
import { RecurringDetailPanel } from "./recurring-detail";
import { RecurringForm } from "./recurring-form";
import { RecurringView } from "./recurring-view";

vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const rent: RecurringItem = {
  id: id(1),
  state: "active",
  payee: {
    id: id(2),
    name: "Westlands Properties",
    kind: "supplier",
    method: "bank",
    archived: false,
  },
  overviewHeading: "transactions",
  category: { id: id(3), name: "Rent" },
  variable: false,
  currency: "kes",
  amountKes: "15000000",
  amountUsdc: null,
  schedule: "monthly",
  scheduleDay: 5,
  startsOn: "2026-11-01",
  endsOn: null,
  payVia: "expendi",
  reminderDays: 3,
  active: true,
  nextDueOn: "2026-12-05",
  nextBill: {
    id: id(4),
    status: "upcoming",
    dueOn: "2026-11-05",
    amountKes: "15000000",
    amountUsdc: null,
  },
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
};

const software: RecurringItem = {
  ...rent,
  id: id(5),
  payee: {
    id: id(6),
    name: "Figma",
    kind: "vendor",
    method: "usdc",
    archived: false,
  },
  overviewHeading: "subscriptions",
  category: { id: id(7), name: "Software" },
  currency: "usd",
  amountKes: null,
  amountUsdc: "45000000",
  payVia: "outside",
  nextBill: null,
};

function withProviders(
  role: "admin" | "accountant",
  children: ReactNode,
): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(recurringKeys.list(ORG), [rent, software]);
  queryClient.setQueryData(recurringKeys.detail(ORG, rent.id), rent);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        {children}
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the recurring payments page", () => {
  it("shows an admin each payment with its schedule, amount and next due date, and the way to add one", () => {
    // #when
    const html = withProviders("admin", <RecurringView />);

    // #then
    expect({
      rent: html.includes("Westlands Properties"),
      schedule: html.includes("Monthly on the 5th"),
      kes: html.includes("KES 150,000.00"),
      usd: html.includes("USD 45.00"),
      nextDue: html.includes("5 Nov 2026"),
      outside: html.includes("Outside Expendi"),
      create: html.includes("New recurring payment"),
    }).toEqual({
      rent: true,
      schedule: true,
      kes: true,
      usd: true,
      nextDue: true,
      outside: true,
      create: true,
    });
  });

  it("shows an accountant the same payments with no way to change them", () => {
    // #when
    const html = withProviders("accountant", <RecurringView />);

    // #then
    expect({
      rent: html.includes("Westlands Properties"),
      usd: html.includes("USD 45.00"),
      create: html.includes("New recurring payment"),
      buttons: (html.match(/<button/g) ?? []).length,
    }).toEqual({
      rent: true,
      usd: true,
      create: false,
      buttons: 2,
    });
  });
});

describe("a recurring payment's details", () => {
  const panel = (canAct: boolean) => (
    <RecurringDetailPanel
      organizationId={ORG}
      itemId={rent.id}
      canAct={canAct}
      onClose={() => undefined}
    />
  );

  it("gives an admin edit, pause and end, with the outstanding bill", () => {
    // #when
    const html = withProviders("admin", panel(true));

    // #then
    expect({
      nextBill: html.includes("Next bill"),
      billLink: html.includes('href="/bills"'),
      edit: html.includes(">Edit payment<"),
      pause: html.includes(">Pause<"),
      end: html.includes(">End payment<"),
    }).toEqual({
      nextBill: true,
      billLink: true,
      edit: true,
      pause: true,
      end: true,
    });
  });

  it("shows an accountant the same details with no actions", () => {
    // #when
    const html = withProviders("accountant", panel(false));

    // #then
    expect({
      nextBill: html.includes("Next bill"),
      reminder: html.includes("3 days before it’s due"),
      edit: html.includes("Edit payment"),
      pause: html.includes(">Pause<"),
      end: html.includes("End payment"),
    }).toEqual({
      nextBill: true,
      reminder: true,
      edit: false,
      pause: false,
      end: false,
    });
  });
});

describe("editing a recurring payment", () => {
  it("shows the payee, schedule, start date and how it's paid as fixed text, not inputs", () => {
    // #when
    const html = withProviders(
      "admin",
      <RecurringForm
        organizationId={ORG}
        item={rent}
        initialDraft={draftFromItem(rent)}
        submitLabel="Save changes"
        submitting={false}
        submitError={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // #then
    expect({
      payeeText: html.includes("Westlands Properties"),
      scheduleText: html.includes("Monthly on the 5th"),
      startsText: html.includes("1 Nov 2026"),
      payViaText: html.includes("Through Expendi"),
      payeeInput: html.includes("Choose a payee"),
      scheduleInput: html.includes("How often"),
      startInput: html.includes("Start date"),
      payViaInput: html.includes("How it’s paid<select"),
      amountInput: html.includes('value="150000.00"'),
      endsInput: html.includes("End date (optional)"),
      saveDisabled: html.includes('<button type="submit" disabled=""'),
    }).toEqual({
      payeeText: true,
      scheduleText: true,
      startsText: true,
      payViaText: true,
      payeeInput: false,
      scheduleInput: false,
      startInput: false,
      payViaInput: false,
      amountInput: true,
      endsInput: true,
      saveDisabled: true,
    });
  });

  it("asks for the payee, schedule, start date and how it's paid on a new payment", () => {
    // #when
    const html = withProviders(
      "admin",
      <RecurringForm
        organizationId={ORG}
        initialDraft={draftFromItem(rent)}
        submitLabel="Set up payment"
        submitting={false}
        submitError={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // #then
    expect({
      scheduleInput: html.includes("How often"),
      startInput: html.includes("Start date"),
      payViaInput: html.includes("How it’s paid<select"),
    }).toEqual({ scheduleInput: true, startInput: true, payViaInput: true });
  });
});
