import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  WalletHistoryResponse,
  WalletResponse,
  WithdrawalAddress,
} from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { walletKeys } from "./wallet-api";
import { WalletView } from "./wallet-view";

vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEPOSIT_ADDRESS = `0x${"a".repeat(40)}`;
const TREASURY = `0x${"b".repeat(40)}`;

const wallet: WalletResponse = {
  status: "active",
  address: DEPOSIT_ADDRESS,
  chain: "base",
  usdcBalance: "1234500000",
  kesEquivalent: { kesCents: "16012345", rate: "129.7" },
};

const addresses: WithdrawalAddress[] = [
  {
    id: id(1),
    address: TREASURY,
    label: "Treasury",
    confirmedAt: "2026-10-01T09:00:00.000Z",
  },
];

const history: WalletHistoryResponse = {
  items: [
    {
      id: id(2),
      type: "withdrawal",
      usdcAmount: "-5000000",
      txHash: `0x${"c".repeat(64)}`,
      counterpartyAddress: TREASURY,
      createdAt: "2026-10-02T09:00:00.000Z",
      payout: {
        id: id(3),
        subjectType: "withdrawal",
        method: "usdc",
        recipientName: "Treasury",
        recipientDetail: TREASURY,
        amountKesCents: "64850",
        status: "paid",
      },
    },
  ],
  nextCursor: null,
};

function render(role: "admin" | "accountant"): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(walletKeys.summary(ORG), wallet);
  queryClient.setQueryData(walletKeys.addresses(ORG), addresses);
  queryClient.setQueryData(walletKeys.history(ORG), {
    pages: [history],
    pageParams: [null],
  });
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled: true,
    enrolledAt: "2026-10-01T09:00:00.000Z",
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <WalletView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the wallet", () => {
  it("shows the balance in USDC and KES and where to deposit, on Base only", () => {
    // #when
    const html = render("accountant");

    // #then
    expect({
      usdc: html.includes("1,234.50 USDC"),
      kes: html.includes("KES 160,123.45"),
      address: html.includes(DEPOSIT_ADDRESS),
      baseOnly: html.includes("Send USDC on Base only"),
      history: html.includes("Withdrawal") && html.includes("-5.00"),
      allowed: html.includes(TREASURY),
    }).toEqual({
      usdc: true,
      kes: true,
      address: true,
      baseOnly: true,
      history: true,
      allowed: true,
    });
  });

  it("lets an admin with a passkey withdraw to an allowed address and change the allowlist", () => {
    // #when
    const html = render("admin");

    // #then
    expect({
      withdrawForm: html.includes('aria-label="Withdraw USDC"'),
      treasuryOption: html.includes(`<option value="${id(1)}"`),
      review: html.includes(">Review<"),
      add: html.includes("Add with passkey"),
      remove: html.includes(">Remove<"),
    }).toEqual({
      withdrawForm: true,
      treasuryOption: true,
      review: true,
      add: true,
      remove: true,
    });
  });

  it("gives an accountant no way to withdraw or change the allowlist", () => {
    // #when
    const html = render("accountant");

    // #then
    expect({
      forms: (html.match(/<form/g) ?? []).length,
      withdraw: html.includes("Withdraw USDC"),
      remove: html.includes(">Remove<"),
      buttons: (html.match(/<button[^>]*>([^<]*)</g) ?? []).map((button) =>
        button.replace(/<button[^>]*>/, "").replace(/<$/, ""),
      ),
    }).toEqual({
      forms: 0,
      withdraw: false,
      remove: false,
      buttons: ["Copy address"],
    });
  });
});
