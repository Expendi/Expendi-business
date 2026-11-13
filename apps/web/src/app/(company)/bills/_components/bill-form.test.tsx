import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ActiveWallet,
  Bill,
  WalletResponse,
} from "@expendi-business/shared";

import { OPEN_BILLS } from "~/app/dev/preview/_harness/fixtures/bills";
import { billKeys } from "~/features/payment-keys";
import { BillForm } from "./bill-form";

vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";

const ACTIVE: ActiveWallet = {
  status: "active",
  address: "company.near",
  chain: "near",
  usdcBalance: "0",
  kesEquivalent: null,
};

const LIMITS: ActiveWallet = {
  ...ACTIVE,
  cashOutLimits: { minKesCents: "2000", maxKesCents: "25000000" },
};

function billTo(payee: string, method: string | null): Bill {
  const found = OPEN_BILLS.find(
    (bill) => bill.payee.name === payee && bill.payee.method === method,
  );
  if (!found) throw new Error(`The samples have a bill to ${payee}.`);
  return found;
}

function render(bill: Bill | null, wallet: WalletResponse): string {
  const client = new QueryClient();
  client.setQueryData(billKeys.kesRate(ORG), wallet);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <BillForm
        organizationId={ORG}
        bill={bill}
        footerSlot={null}
        onSaved={() => undefined}
        onCancel={() => undefined}
      />
    </QueryClientProvider>
  );
  return renderToStaticMarkup(tree);
}

const HINT = "Smallest amount: KES 20";

describe("the bill form's smallest amount", () => {
  it("shows under the amount for a payee paid by cash-out, including a variable bill's amount entered before paying", () => {
    // #when
    const shown = [
      billTo("Safaricom", "mpesa_paybill"),
      billTo("Bidco Kenya", "bank"),
      billTo("KRA", "mpesa_paybill"),
    ].map((bill) => render(bill, LIMITS).includes(HINT));

    // #then
    expect(shown).toEqual([true, true, true]);
  });

  it("isn't shown for a USDC payee, a payee paid outside Expendi or one with no payment details", () => {
    // #when
    const shown = [
      billTo("Figma", "usdc"),
      billTo("Hotpoint Appliances", "outside"),
      billTo("CarMax Mechanics", null),
    ].map((bill) => render(bill, LIMITS).includes("Smallest amount"));

    // #then
    expect(shown).toEqual([false, false, false]);
  });

  it("isn't shown before a payee is chosen", () => {
    // #then
    expect(render(null, LIMITS).includes("Smallest amount")).toBe(false);
  });

  it("isn't shown while the minimum is unknown, or by an API that doesn't send limits", () => {
    // #given
    const safaricom = billTo("Safaricom", "mpesa_paybill");
    const noMinimum: WalletResponse = {
      ...ACTIVE,
      cashOutLimits: { minKesCents: null, maxKesCents: "25000000" },
    };

    // #then
    expect([
      render(safaricom, noMinimum).includes("Smallest amount"),
      render(safaricom, ACTIVE).includes("Smallest amount"),
    ]).toEqual([false, false]);
  });
});
