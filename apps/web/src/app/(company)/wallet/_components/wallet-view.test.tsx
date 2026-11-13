import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WalletHistoryItem,
  WalletHistoryResponse,
  WalletResponse,
} from "@expendi-business/shared";

import {
  ACCOUNTS_WALLET,
  ALLOWED_ADDRESSES,
  LEDGER,
  PAID_FROM_ACCOUNTS,
} from "~/app/dev/preview/_harness/fixtures/wallet";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { billKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { walletKeys } from "./wallet-api";
import { WalletView } from "./wallet-view";

vi.mock("next/navigation", () => ({
  usePathname: () => "/wallet",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";

/** 09:30 on 6 November 2026 in Nairobi. */
const NOW = new Date("2026-11-06T06:30:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function pages(items: WalletHistoryItem[], nextCursor: string | null) {
  const page: WalletHistoryResponse = { items, nextCursor };
  return { pages: [page], pageParams: [null] };
}

interface Setup {
  readonly role?: "admin" | "accountant";
  readonly wallet?: WalletResponse;
  readonly history?: WalletHistoryItem[];
  readonly walletError?: boolean;
}

function render({
  role = "admin",
  wallet = ACCOUNTS_WALLET,
  history = LEDGER.slice(0, 9),
  walletError = false,
}: Setup = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retryOnMount: !walletError } },
  });
  if (walletError) {
    client
      .getQueryCache()
      .build(client, { queryKey: walletKeys.summary(ORG) })
      .setState({ status: "error", error: new Error("Network down") });
  } else {
    client.setQueryData(walletKeys.summary(ORG), wallet);
  }
  client.setQueryData(
    walletKeys.history(ORG),
    pages(history, history.length ? (history.at(-1)?.id ?? null) : null),
  );
  client.setQueryData(walletKeys.balanceHistory(ORG), pages(LEDGER, null));
  client.setQueryData(walletKeys.addresses(ORG), ALLOWED_ADDRESSES);
  client.setQueryData(billKeys.paidFromAccounts(ORG), PAID_FROM_ACCOUNTS);
  client.setQueryData(queryKeys.approvalPasskey, {
    enrolled: true,
    enrolledAt: "2026-10-01T09:00:00.000Z",
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Mwangaza Logistics", role }}
      >
        <WalletView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("Accounts", () => {
  it("shows the USDC wallet's balance, this month's flows and the balance chart", () => {
    // #when
    const html = render({ role: "accountant" });
    const page = text(html);

    // #then
    expect({
      title: html.includes(">Accounts</h1>"),
      balance: html.includes(">16,420<") && html.includes(">.80<"),
      kes: page.includes("≈ KES") && page.includes("2,118,283 "),
      rate: page.includes("Rate today: KES 129 per USDC"),
      moneyIn: page.includes("+6,031.78"),
      moneyOut: page.includes("−4,257.75"),
      chart: html.includes(
        "Lowest 2,646.77 USDC on 28 Oct; 16,420.80 USDC today",
      ),
      table: page.includes("Show as table"),
    }).toEqual({
      title: true,
      balance: true,
      kes: true,
      rate: true,
      moneyIn: true,
      moneyOut: true,
      chart: true,
      table: true,
    });
  });

  it("lists the history under day headings, with filters and Load more", () => {
    // #when
    const page = text(render());

    // #then
    expect({
      days: ["Today", "Yesterday", "Wednesday 4 Nov", "Tuesday 3 Nov"].every(
        (day) => page.includes(day),
      ),
      filters: ["All", "Money in", "Money out"].every((label) =>
        page.includes(label),
      ),
      rows: [
        "Twiga Foods",
        "KES 186,000 · Bill",
        "From mwangaza-treasury.near",
        "Zuku payment failed, money returned",
        "To Reserve on Coinbase",
      ].every((line) => page.includes(line)),
      moving: page.includes("On its way") && page.includes("Sending"),
      time: page.includes("9:20 AM"),
      datedOnceOlder: /4 Nov, \d{1,2}:\d{2} [AP]M/.test(page),
      more: page.includes("Load more"),
    }).toEqual({
      days: true,
      filters: true,
      rows: true,
      moving: true,
      time: true,
      datedOnceOlder: true,
      more: true,
    });
  });

  it("shows money in green and money out red in the history only", () => {
    // #when
    const html = render();
    const tinted = (tone: string, figure: string) =>
      new RegExp(`text-${tone}-700[^>]*>${figure}`).test(html);

    // #then
    expect({
      deposit: tinted("success", "\\+6,000\\.00"),
      refund: tinted("success", "\\+31\\.78"),
      payment: tinted("error", "−1,441\\.86"),
      withdrawal: tinted("error", "−2,000\\.00"),
      monthIn: tinted("success", "\\+6,031\\.78"),
      monthOut: tinted("error", "−4,257\\.75"),
    }).toEqual({
      deposit: true,
      refund: true,
      payment: true,
      withdrawal: true,
      monthIn: false,
      monthOut: false,
    });
  });

  it("shows where to deposit, the allowlist and the paid-from accounts", () => {
    // #when
    const html = render({ role: "accountant" });
    const page = text(html);

    // #then
    expect({
      deposit: page.includes("Send USDC on NEAR only"),
      account:
        page.includes("NEAR account") &&
        ["8f3a", "5b2c", "3d2e"].every((group) => html.includes(`>${group}<`)),
      onNear: page.includes("On NEAR"),
      copy: page.includes("Copy address"),
      allowed:
        page.includes("Base · 0x12ab…9f3c · Added 12 Aug") &&
        page.includes("NEAR · 5e6f7a…5e6f · Added 3 Sep"),
      paidFrom: PAID_FROM_ACCOUNTS.every((account) =>
        page.includes(account.name.replace("'", "&#x27;")),
      ),
      kind: page.includes("Bank account") && page.includes("Mobile money"),
      settings: html.includes('href="/settings?section=accounts"'),
    }).toEqual({
      deposit: true,
      account: true,
      onNear: true,
      copy: true,
      allowed: true,
      paidFrom: true,
      kind: true,
      settings: true,
    });
  });

  it("lets an admin withdraw, add and remove addresses", () => {
    // #when
    const page = render({ role: "admin" });

    // #then
    expect({
      withdraw: page.includes(">Withdraw<"),
      fundIn: page.includes(">Fund in<"),
      otherChain: page.includes("Fund in from another chain"),
      add: page.includes(">Add address<"),
      remove: page.includes('aria-label="Remove Reserve on Coinbase"'),
      viewOnly: page.includes("View only"),
    }).toEqual({
      withdraw: true,
      fundIn: true,
      otherChain: true,
      add: true,
      remove: true,
      viewOnly: false,
    });
  });

  it("gives an accountant no way to withdraw or change the allowlist", () => {
    // #when
    const page = render({ role: "accountant" });

    // #then
    expect({
      withdraw: page.includes(">Withdraw<"),
      fundIn: page.includes(">Fund in<"),
      otherChain: page.includes("Fund in from another chain"),
      add: page.includes(">Add address<"),
      remove: page.includes(">Remove<"),
      viewOnly: page.includes(
        "View only. Only admins withdraw or change this list.",
      ),
    }).toEqual({
      withdraw: false,
      fundIn: true,
      otherChain: false,
      add: false,
      remove: false,
      viewOnly: true,
    });
  });

  it("says when the wallet is still being set up", () => {
    // #when
    const admin = text(render({ wallet: { status: "creating" } }));
    const accountant = text(
      render({ role: "accountant", wallet: { status: "creating" } }),
    );

    // #then
    expect({
      admin: admin.includes("Finish setting up wallet"),
      accountant: accountant.includes("An admin can finish setting it up."),
      noHistory: admin.includes("History"),
    }).toEqual({ admin: true, accountant: true, noHistory: false });
  });

  it("offers Try again when the wallet doesn't load", () => {
    // #when
    const page = text(render({ walletError: true }));

    // #then
    expect({
      title: page.includes("Accounts didn&#x27;t load"),
      retry: page.includes("Try again"),
    }).toEqual({ title: true, retry: true });
  });

  it("says when nothing has moved yet", () => {
    // #when
    const page = text(render({ history: [] }));

    // #then
    expect({
      empty: page.includes("No movements yet"),
      more: page.includes("Load more"),
    }).toEqual({ empty: true, more: false });
  });
});
